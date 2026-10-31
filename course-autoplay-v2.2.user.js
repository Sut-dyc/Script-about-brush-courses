// ==UserScript==
// @name         干部在线学习网 · 视频连播
// @namespace    local.liaoning.course-player
// @version      2.2.0
// @description  自动连播章节和不同课程，自动返回未完成课程列表及翻页，在一个标签页中运行。
// @match        https://zyjs.lngbzx.gov.cn/pc/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(() => {
  'use strict';


  // 继续学习提示可能在播放器和目录创建之前出现。
  function createContinueGate(env) {
    let seen = null;
    return {
      reset() { seen = null; },
      check() {
        const prompt = env.findPrompt();
        if (!prompt) { seen = null; return null; }
        if (env.options.confirm === false) {
          return { message: '检测到继续学习提示；可在面板开启自动确认' };
        }
        if (seen?.key !== prompt.key) {
          if (!prompt.click) return { error: '找到继续学习提示，但未能唯一识别确定按钮' };
          seen = { key: prompt.key, since: env.now() };
          prompt.click();
        } else if (env.now() - seen.since >= 12000) {
          return { error: '继续学习提示未关闭，已停止以避免重复点击' };
        }
        return { message: '已确认继续学习，等待提示关闭…' };
      }
    };
  }

  // 改写地址而不触发旧页面的 hash 路由，然后加载新文档。
  // URL 参数保持网站原值，不拼接视频地址、不探测替代源。
  function navigateFresh(url, nav) {
    const current = new URL(nav.href);
    const target = new URL(url, current);
    if (target.origin !== current.origin) throw new Error('InvalidNavigationOrigin');
    if (target.pathname === current.pathname && target.search === current.search) {
      nav.replaceURL(target.href);
      nav.reload();
    } else {
      nav.assign(target.href);
    }
  }

  function createController(env) {
    const promptGate = createContinueGate(env);
    const state = {
      running: false, runId: 0, phase: 'stopped', pending: null,
      course: '', missingSince: null, prompt: null, busy: null,
      catalogMissingSince: null, lastPlay: -Infinity, failures: 0, lastPage: null, stablePage: null, reason: '', message: ''
    };
    const say = text => { state.message = text; env.status(text, state.running); };
    const changedMedia = (a, b) => a.video !== b.video ||
      a.source !== b.source || a.revision !== b.revision;

    function stop(message = '已停止，视频已暂停', reason = 'error') {
      state.reason = reason;
      state.running = false;
      state.runId++;
      state.phase = 'stopped';
      state.pending = null;
      state.busy = null;
      const videos = new Set([state.lastPage?.video]);
      // 点击停止前播放器可能刚刚换节点，重新读取一次当前视频。
      try { videos.add(env.read()?.video); } catch {}
      for (const video of videos) { if (video) env.pause(video); }
      say(message);
    }

    function start() {
      promptGate.reset();
      state.runId++;
      Object.assign(state, {
        running: true, phase: 'playing', pending: null, course: '', reason: '',
        missingSince: null, prompt: null, busy: null,
        catalogMissingSince: null, lastPlay: -Infinity, failures: 0, stablePage: null
      });
      tick(); // 在面板点击的同一调用中尝试播放，保留用户手势。
    }

    function attemptPlay(page) {
      const now = env.now();
      if (state.busy || now - state.lastPlay < 4000) return;
      const ticket = { runId: state.runId, page };
      state.busy = ticket;
      state.lastPlay = now;
      const valid = () => state.running && ticket.runId === state.runId &&
        state.lastPage && !changedMedia(page, state.lastPage);
      let result;
      try { result = env.play(page.video); }
      catch (error) { result = Promise.reject(error); }
      Promise.resolve(result).then(() => {
        if (valid()) state.failures = 0;
        else if (!state.running || state.lastPage?.video !== page.video) env.pause(page.video);
      }).catch(error => {
        if (!valid()) return;
        if (error?.name === 'NotAllowedError') {
          stop('浏览器阻止自动播放：勾选静音后，在面板重新开启');
        } else if (error?.name === 'NotSupportedError') {
          stop('视频格式或地址不可播放', 'media-error');
        } else if (++state.failures >= 3) {
          stop('播放连续失败', 'media-error');
        } else say('播放暂未成功，稍后重试');
      }).finally(() => {
        if (state.busy === ticket) state.busy = null;
      });
    }

    function tick() {
      if (!state.running) return;
      try {
        const now = env.now();
        const promptState = promptGate.check();
        if (promptState?.error) { stop(promptState.error); return; }
        if (promptState?.message) { say(promptState.message); return; }
        const page = env.read();
        if (!page?.video) {
          state.missingSince ??= now;
          if (now - state.missingSince >= 20000) stop('未找到课程视频', 'media-error');
          else say('等待课程视频加载…');
          return;
        }
        state.missingSince = null;
        if (state.lastPage && changedMedia(page, state.lastPage)) {
          state.busy = null;
          state.failures = 0;
          state.lastPlay = -Infinity;
        }
        state.lastPage = page;
        if (page.catalog) {
          if (state.course && state.course !== page.catalog) {
            stop('课程目录已变化，请在新课程中重新开启');
            return;
          }
          state.course = page.catalog;
        }
        if (!page.catalog || page.index < 0) {
          env.pause(page.video);
          state.catalogMissingSince ??= now;
          if (page.video.ended) return stop('本节已结束，但未能唯一识别当前章节');
          if (now - state.catalogMissingSince >= 20000) return stop('章节目录丢失，本课程未完成', 'media-error');
          say('目录未就绪，已暂停视频，等待本课程目录…');
          return;
        }
        state.catalogMissingSince = null;
        env.mute(page.video, env.options.muted);
        if (page.video.error) {
          stop(`播放器报错（代码 ${page.video.error.code}）`, 'media-error');
          return;
        }

        // 菜单高亮可能早于新视频更新，必须保留上一个稳定播放周期。
        if (!state.pending && state.stablePage && page.index >= 0 &&
            page.index !== state.stablePage.index &&
            (!changedMedia(state.stablePage, page) || page.video.ended || page.video.readyState < 1)) {
          state.phase = 'end-wait';
          state.pending = { from: state.stablePage, since: now };
        }

        if (state.pending) {
          const p = state.pending;
          if (!page.catalog || page.index < 0) {
            if (now - p.since >= 20000) stop('切换时无法确定当前章节，已停止');
            else say('等待章节目录更新…');
            return;
          }
          const mediaChanged = changedMedia(p.from, page);
          const newMediaReady = mediaChanged && page.video.readyState >= 1 && !page.video.ended;
          if (state.phase === 'switching') {
            if (page.index === p.target && newMediaReady) {
              state.pending = null;
              state.phase = 'playing';
            } else {
              if (now - p.since >= 20000) stop('下一节加载超时，本课程未完成', 'media-error');
              else say(`正在切换第 ${p.target + 1} 节，等待视频加载…`);
              return;
            }
          } else {
            // 网站自行换章时，等高亮与视频同时更新后接管播放。
            if (page.index !== p.from.index) {
              if (newMediaReady) {
                state.pending = null;
                state.phase = 'playing';
              } else {
                if (now - p.since >= 20000) stop('目录已切换，但视频未加载', 'media-error');
                else say('网站正在切换章节，等待视频加载…');
                return;
              }
            } else if (mediaChanged) {
              // 视频先更新也要等菜单高亮更新，不能把新视频误记为上一节。
              if (now - p.since >= 20000) stop('视频已更换，但章节高亮未更新，已停止');
              else say('视频已加载，等待章节目录同步…');
              return;
            } else if (!page.video.ended) {
              if (page.video.readyState >= 1) {
                state.pending = null;
                state.phase = 'playing';
              } else {
                if (now - p.since >= 20000) stop('播放器状态异常，已停止');
                return;
              }
            } else if (now - p.since < 3000) {
              say('本节已播完，即将自动切换下一节…');
              return;
            } else if (page.index === page.items.length - 1) {
              stop('本课程已播至末尾', 'complete');
              return;
            } else if (!env.options.next) {
              stop('本节已播完；自动下一节已关闭');
              return;
            } else {
              const target = page.index + 1;
              state.phase = 'switching';
              state.pending = { from: page, target, since: now };
              // 先锁定状态，再点击：一个结束周期最多点击一次。
              env.next(page, target);
              say(`已点击第 ${target + 1} 节，等待视频加载…`);
              return;
            }
          }
        }

        if (page.video.ended) {
          if (page.index < 0 || !page.catalog) {
            stop('本节已结束，但未能唯一识别当前章节');
            return;
          }
          state.phase = 'end-wait';
          state.pending = { from: page, since: now };
          say('本节已播完，即将自动切换下一节…');
          return;
        }
        state.stablePage = page;
        if (page.video.paused) {
          say('正在恢复播放…');
          attemptPlay(page);
        } else {
          const part = page.index >= 0 ? `第 ${page.index + 1}/${page.items.length} 节` : '当前视频';
          say(`连播中 · ${part}`);
        }
      } catch (error) {
        stop('页面操作失败，已停止。可刷新课程页面后重试');
        console.warn('[辽宁视频连播]', error?.name || 'Error');
      }
    }
    function notifyEnded(video) {
      const from = state.stablePage || state.lastPage;
      if (!state.running || state.pending || !from || from.video !== video) return;
      state.phase = 'end-wait';
      state.pending = { from, since: env.now() };
    }
    return { start, stop, tick, notifyEnded,
      get running() { return state.running; },
      get reason() { return state.reason; },
      get message() { return state.message; }
    };
  }


function parseCourseUrl(value, baseURL) {
  try {
    const base = new URL(baseURL);
    const url = new URL(String(value), base);
    if (url.origin !== base.origin || url.pathname !== '/pc/index.html' ||
        url.username || url.password) return null;
    const [route, query = ''] = url.hash.slice(1).split('?');
    const kind = route === '/video_detail' ? 'video' :
      route === '/course_detail' ? 'detail' : null;
    if (!kind) return null;
    const params = new URLSearchParams(query);
    const id = params.get('id');
    if (params.getAll('id').length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(id || '')) return null;
    return { kind, id, url: url.href };
  } catch { return null; }
}

function createCourseScheduler(env, savedState = {}) {
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const listBase = new URL(env.listURL);
  const listRoute = listBase.hash.slice(1).split('?')[0];
  const oldEnabled = savedState.enabled === true;
  const rowMap = Object.create(null);
  for (const [key, id] of Object.entries(savedState.rowMap || {})) {
    if (key.length <= 1000 && validId(id)) rowMap[key] = id;
  }
  const state = {
    version: 2, enabled: false, phase: 'idle',
    currentId: validId(savedState.currentId) ? savedState.currentId : '',
    currentRowKey: String(savedState.currentRowKey || ''),
    currentTitle: String(savedState.currentTitle || '').slice(0,300),
    listPage: Number.isInteger(savedState.listPage) && savedState.listPage > 0 ? savedState.listPage : 1,
    restoringPage: false,
    scanWrapped: savedState.scanWrapped === true,
    failed: (Array.isArray(savedState.failed) ? savedState.failed : [])
      .filter(item => item && validId(item.id)).slice(-1000)
      .map(item => ({id:item.id, title:String(item.title || '').slice(0,300),
        reason:String(item.reason || '').slice(0,300), at:Number(item.at) || 0})),
    rowMap,
    doneIds: [...new Set((Array.isArray(savedState.doneIds) ? savedState.doneIds : []).filter(validId))],
    navIntent: savedState.navIntent || null,
    updatedAt: Number(savedState.updatedAt) || 0,
    phaseSince: env.now(),
    mustFirst: false,
    visitedPages: [],
    previousPage: null
  };
  let epoch = 0;
  let stableKey = '';
  let stableSince = env.now();
  let captureMode = null;

  const excluded = id => state.doneIds.includes(id) || state.failed.some(item => item.id === id);
  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }
  function save() {
    state.updatedAt = env.now();
    env.save(snapshot());
  }
  function say(text) {
    env.status(text, state.enabled, state.doneIds.length);
  }
  function scene() {
    const raw = env.scene() || {};
    try {
      const url = new URL(raw.url, env.listURL);
      const route = url.hash.slice(1).split('?')[0];
      if (raw.kind === 'list' && url.origin === listBase.origin &&
          url.pathname === listBase.pathname && route === listRoute) {
        return { ...raw, url: url.href };
      }
      const parsed = parseCourseUrl(url.href, env.listURL);
      if (parsed && raw.kind === parsed.kind && String(raw.id) === parsed.id) {
        return { ...raw, ...parsed };
      }
    } catch {}
    return { ...raw, kind: 'other' };
  }
  function phase(value) {
    state.phase = value;
    state.phaseSince = env.now();
    stableKey = '';
    stableSince = env.now();
    save();
  }
  function stop(message = '已停止跨课程连播') {
    // 先使持久化开关和所有晚到回调失效，再撤销页面动作。
    state.enabled = false;
    state.phase = 'idle';
    state.navIntent = null;
    epoch++;
    let storageError = false;
    try { save(); } catch { storageError = true; }
    try { env.cancelCapture(); } catch {}
    try { env.player.stop(message, 'manual'); } catch {}
    try { env.pauseAll(); } catch {}
    say(storageError ? message + '；控制状态保存失败' : message);
    env.onStopped?.();
  }
  function fail(message) { stop(message); }
  function skipCourse(message) {
    if (!validId(state.currentId)) return fail(message);
    env.cancelCapture();
    env.player.stop(message, 'skipped');
    env.pauseAll();
    if (!state.failed.some(item => item.id === state.currentId)) {
      state.failed.push({id:state.currentId, title:state.currentTitle || state.currentId,
        reason:message, at:env.now()});
    }
    save();
    if (env.options.crossCourse === false) return stop('本课程加载失败；跨课程连播已关闭');
    returnList();
    say('已记录并跳过失败课程：' + message);
  }
  function wait(message, timeout = 30000) {
    if (env.now() - state.phaseSince >= timeout) {
      fail(message.replace(/…$/, '') + '超时，已停止');
    } else say(message);
  }
  function enterList(restore = true) {
    state.currentId = '';
    state.currentRowKey = '';
    state.currentTitle = '';
    state.navIntent = null;
    state.restoringPage = restore;
    state.mustFirst = false;
    state.visitedPages = [];
    state.previousPage = null;
    phase('list');
  }
  function returnList() {
    state.navIntent = { kind: 'list', id: '', url: env.listURL, issuedAt: env.now() };
    state.restoringPage = true;
    state.visitedPages = [];
    phase('returning');
    say('正在返回我的课程，准备下一门…');
    env.navigate(env.listURL);
  }
  function adoptCourse(current) {
    state.currentId = current.id;
    state.currentTitle = current.title || state.currentTitle;
    state.navIntent = null;
    if (excluded(current.id)) {
      returnList();
    } else {
      phase(current.kind === 'video' ? 'load-player' : 'detail');
    }
  }
  function start() {
    if (state.enabled) return;
    epoch++;
    state.enabled = true;
    state.navIntent = null;
    state.visitedPages = [];
    const current = scene();
    state.scanWrapped = false;
    if (current.kind === 'video' && env.refreshOnStart && !excluded(current.id)) {
      state.currentId = current.id;
      state.currentTitle = current.title || state.currentTitle;
      state.navIntent = {kind:'video', id:current.id, url:current.url, issuedAt:env.now()};
      env.pauseAll();
      phase('opening');
      env.navigate(current.url);
      return;
    }
    if (current.kind === 'video' || current.kind === 'detail') adoptCourse(current);
    else if (current.kind === 'list') enterList(false);
    else returnList();
    tick();
  }
  function resume() {
    if (!oldEnabled || state.enabled) return false;
    const age = env.now() - Number(savedState.updatedAt || 0);
    const current = scene();
    const intent = savedState.navIntent;
    const intended = intent && env.now() - Number(intent.issuedAt) >= 0 &&
      env.now() - Number(intent.issuedAt) <= 120000 &&
      (intent.kind === 'list' ? current.kind === 'list' :
        validId(intent.id) && current.id === intent.id &&
        (current.kind === intent.kind || intent.kind === 'detail' && current.kind === 'video'));
    const sameCourse = validId(savedState.currentId) && current.id === savedState.currentId &&
      ['video', 'detail'].includes(current.kind);
    const sameList = current.kind === 'list' &&
      ['list', 'paging', 'returning'].includes(savedState.phase);
    if (age < 0 || age > 12 * 60 * 60 * 1000 || !(intended || sameCourse || sameList)) {
      stop('页面与保存的连播任务不匹配，未自动恢复');
      return false;
    }
    epoch++;
    state.enabled = true;
    if (current.kind === 'list') enterList();
    else adoptCourse(current);
    tick();
    return true;
  }
  function reset() {
    if (state.enabled) return false;
    state.doneIds = [];
    state.failed = [];
    state.listPage = 1;
    state.scanWrapped = false;
    state.rowMap = Object.create(null);
    state.currentId = '';
    state.currentRowKey = '';
    state.navIntent = null;
    save();
    say('本轮记录已清空，可以开始新一轮');
    return true;
  }

  function capturedURL(value, expectedEpoch) {
    if (!state.enabled || state.phase !== 'capture' || epoch !== expectedEpoch) return;
    const parsed = parseCourseUrl(value, env.listURL);
    if (!parsed) return fail('课程入口返回了不支持的地址，已停止');
    if (captureMode === 'detail' && (parsed.id !== state.currentId || parsed.kind !== 'video')) {
      return fail('课程详情的播放地址与当前课程不一致，已停止');
    }
    env.cancelCapture();
    if (captureMode === 'list') {
      state.rowMap[state.currentRowKey] = parsed.id;
      if (excluded(parsed.id)) {
        state.currentId = '';
        state.currentRowKey = '';
        if (scene().kind !== 'list') return returnList();
        phase('list');
        say('该课程本轮已处理，继续查找下一门…');
        return;
      }
    }
    state.currentId = parsed.id;
    state.navIntent = { ...parsed, issuedAt: env.now() };
    phase('opening');
    say('正在当前标签页打开课程…');
    env.navigate(parsed.url);
  }
  function capture(element, mode) {
    captureMode = mode;
    const expectedEpoch = epoch;
    phase('capture');
    say(mode === 'detail' ? '正在进入本课程视频…' : '正在读取下一门课程入口…');
    env.captureStart(
      element,
      value => {
        try { capturedURL(value, expectedEpoch); }
        catch { if (state.enabled && epoch === expectedEpoch) fail('打开课程失败，已停止'); }
      },
      error => {
        if (state.enabled && epoch === expectedEpoch && state.phase === 'capture') {
          fail(typeof error === 'string' ? error : '无法读取课程播放入口，已停止');
        }
      }
    );
  }
  function beginPaging(list, first) {
    const token = String(list.page) + '|' + list.fingerprint;
    if (state.visitedPages.includes(token) && !first) {
      return fail('检测到重复分页，已停止以避免循环');
    }
    if (!first) state.visitedPages.push(token);
    state.previousPage = { page: list.page, fingerprint: list.fingerprint };
    phase('paging');
    say(first ? '正在返回列表第一页…' : '本页已遍历，正在打开下一页…');
    if (first) env.firstPage();
    else env.nextPage();
  }
  function listTick(current) {
    if (current.kind !== 'list') return fail('已离开我的课程列表，连播已停止');
    const list = current.list;
    if (!list?.ready || list.loading || !Number.isInteger(list.page) || list.page < 1) {
      return wait('等待课程列表加载…');
    }
    if (!list.rows.length && list.total !== 0) return wait('等待课程记录加载…');
    const key = JSON.stringify([
      list.page, list.fingerprint, list.rows.map(row => row.progress), list.total, list.nextEnabled
    ]);
    if (key !== stableKey) {
      stableKey = key;
      stableSince = env.now();
      return say('等待课程列表稳定…');
    }
    if (env.now() - stableSince < 1500) return say('等待课程列表稳定…');
    // 新文档默认展示第一页；只恢复到离开时的页码，不选择途经页面的课程。
    if (state.restoringPage) {
      if (list.page > state.listPage) {
        if (list.firstAvailable === false) return fail('无法恢复课程列表页码，已停止');
        return beginPaging(list, true);
      }
      if (list.page < state.listPage && list.nextEnabled) return beginPaging(list, false);
      // 已完成记录可能移出未完成列表，页数减少时接受当前最后一页。
      state.restoringPage = false;
    }
    state.listPage = list.page;
    const keys = list.rows.map(row => row.key);
    if (keys.some(key => !key) || new Set(keys).size !== keys.length) {
      return fail('列表中存在无法唯一识别的课程记录，已停止');
    }
    const candidate = list.rows.find(row => {
      const id = state.rowMap[row.key];
      return !(Number.isFinite(row.progress) && row.progress >= 100) &&
        !(id && excluded(id));
    });
    if (candidate) {
      if (!candidate.element) return fail('未完成课程缺少唯一的开始学习按钮，已停止');
      state.currentRowKey = candidate.key;
      state.currentTitle = candidate.title || candidate.key;
      state.currentId = '';
      return capture(candidate.element, 'list');
    }
    if (list.nextEnabled) return beginPaging(list, false);
    // 补查一次前页，覆盖从中间页启动和已完成记录移除后向前移动的课程。
    if (!state.scanWrapped && list.page > 1 && list.firstAvailable !== false) {
      state.scanWrapped = true;
      state.visitedPages = [];
      state.listPage = 1;
      return beginPaging(list, true);
    }
    stop('本轮课程列表已遍历，播至末尾 ' + state.doneIds.length + ' 门，失败跳过 ' + state.failed.length + ' 门；学时以平台记录为准');
  }

  function tick() {
    if (!state.enabled) return;
    try {
      if (env.online?.() === false) return fail('网络已断开，连播已停止；恢复网络后可重新开启');
      const current = scene();
      if (state.phase === 'returning') {
        if (current.kind === 'list') enterList();
        else return wait('等待返回我的课程…');
      }
      if (state.phase === 'opening') {
        const target = state.navIntent;
        if (target && current.id === target.id &&
            (current.kind === target.kind || target.kind === 'detail' && current.kind === 'video')) {
          state.navIntent = null;
          phase(current.kind === 'video' ? 'load-player' : 'detail');
        } else return wait('等待课程页面打开…');
      }
      if (state.phase === 'capture') {
        // 兼容站点在本标签直接跳转，只有匹配已知课程路由才接受。
        if (['video', 'detail'].includes(current.kind)) {
          if (captureMode === 'list' || current.kind === 'video') {
            capturedURL(current.url, epoch);
            return;
          }
        }
        return wait('等待课程入口响应…', 20000);
      }
      if (state.phase === 'detail') {
        if (current.kind === 'video' && current.id === state.currentId) phase('load-player');
        else if (current.kind === 'detail' && current.id === state.currentId) {
          if (current.canEnterDetail) return capture(null, 'detail');
          if (env.now() - state.phaseSince >= 30000) return skipCourse('课程详情入口加载超时');
          return say('等待课程详情中的开始学习入口…');
        } else return fail('课程详情页面已变化，连播已停止');
      }
      if (state.phase === 'load-player') {
        if (current.kind !== 'video' || current.id !== state.currentId) {
          return fail('视频页面与目标课程不一致，已停止');
        }
        // 目录未就绪时，任何已经存在的视频都不能作为本课程开始播放。
        env.pauseAll();
        const promptState = env.handleLoadingPrompt?.();
        if (!current.hasVideo || !current.hasChapters || current.mediaReady === false) {
          if (env.options.confirm === false && promptState?.message) return say(promptState.message);
          if (env.now() - state.phaseSince >= 30000) {
            return skipCourse('视频或章节目录加载失败（等待30秒）');
          }
          return say('等待本课程视频与目录，超时将记录并跳过…');
        }
        if (promptState?.error) return fail(promptState.error);
        if (promptState?.message) return say(promptState.message);
        if (current.mediaError) return skipCourse('播放器媒体错误：' + current.mediaError);
        phase('playing');
        env.player.start();
        say('正在播放本课程，结束后自动切换下一门');
        return;
      }
      if (state.phase === 'playing') {
        if (current.kind !== 'video' || current.id !== state.currentId) {
          return fail('播放中的课程页面已变化，已停止');
        }
        if (env.player.running) env.player.tick();
        if (!env.player.running) {
          if (env.player.reason === 'media-error') return skipCourse(env.player.message || '本课程视频加载失败');
          if (env.player.reason !== 'complete') return fail(env.player.message || '本课程播放中断，已停止');
          if (!state.doneIds.includes(state.currentId)) state.doneIds.push(state.currentId);
          phase('settling');
          say('本课程已播至末尾，等待页面保存进度…');
        }
        return;
      }
      if (state.phase === 'settling') {
        if (current.kind !== 'video' || current.id !== state.currentId) {
          return fail('等待保存进度时页面已变化，已停止');
        }
        if (env.now() - state.phaseSince < 8000) return say('本课程已播至末尾，等待页面保存进度…');
        if (env.options.crossCourse === false) return stop('本课程已播至末尾；跨课程连播已关闭');
        return returnList();
      }
      if (state.phase === 'paging') {
        if (current.kind !== 'list') return fail('分页时离开了课程列表，已停止');
        const list = current.list;
        const previous = state.previousPage;
        if (list?.ready && !list.loading && list.page !== previous?.page &&
            list.fingerprint !== previous?.fingerprint) {
          phase('list');
        } else return wait('等待下一页课程记录加载…');
      }
      if (state.phase === 'list') listTick(current);
    } catch {
      if (state.enabled) fail('跨课程操作失败，已停止');
    }
  }

  return {
    start, resume, stop, reset, tick,
    get running() { return state.enabled; },
    get snapshot() { return snapshot(); }
  };
}



  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { createController, createCourseScheduler, parseCourseUrl, createContinueGate, navigateFresh };
    return;
  }
  if (window.top !== window.self) return;
  const PANEL_ID = 'ln-course-continuous-player-panel';
  if (document.getElementById(PANEL_ID)) return;

  const STORAGE_KEY = 'ln-course-autoplay-v2-session';
  const LOCK_NAME = 'ln-course-autoplay-single-player-v2';
  const LIST_URL = new URL('/pc/index.html#/study_center/my_course', location.origin).href;
  const clean = value => String(value || '').replace(/\s+/g, '').replace(/？/g, '?');
  const visible = el => {
    if (!el?.isConnected || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}'); } catch {}
  const options = {
    muted: saved.options?.muted !== false,
    confirm: saved.options?.confirm !== false,
    next: true,
    crossCourse: saved.options?.crossCourse !== false
  };
  let observedVideo = null, observedSource = '', revision = 0, mediaAbort = null;
  let lockHeld = false, releaseLock = null, acquiring = false, lockRequest = 0;
  let captureCleanup = null;
  let documentNavigating = false;
  let scheduler;
  let videoStatus = '';

  function readPage() {
    const videos = [...document.querySelectorAll('.video_box .player video')].filter(visible);
    if (videos.length !== 1) return null;
    const video = videos[0];
    if (video !== observedVideo) {
      mediaAbort?.abort();
      mediaAbort = new AbortController();
      observedVideo = video;
      revision++;
      video.addEventListener('ended', () => controller.notifyEnded(video),
        { capture: true, signal: mediaAbort.signal });
      for (const event of ['loadstart', 'emptied']) {
        video.addEventListener(event, () => { revision++; }, { signal: mediaAbort.signal });
      }
    }
    const source = video.currentSrc || video.getAttribute('src') || '';
    if (source !== observedSource) { observedSource = source; revision++; }
    const items = [...video.closest('.video_box').querySelectorAll('.course_menu .menu_item')];
    const active = items.filter(item => item.classList.contains('currentChapter'));
    return {
      video, source, revision, items,
      index: active.length === 1 ? items.indexOf(active[0]) : -1,
      catalog: items.map(item => clean(item.textContent)).join('\n')
    };
  }

  function findContinuePrompt() {
    const all = [...document.querySelectorAll('body div, body p, body span, body section')];
    const message = all.find(el => clean(el.textContent) === '是否继续学习?' && visible(el) &&
      ![...el.children].some(child => clean(child.textContent) === '是否继续学习?'));
    if (!message) return null;
    let box = message.parentElement;
    for (let depth = 0; box && box !== document.body && depth < 7; depth++, box = box.parentElement) {
      const text = clean(box.textContent);
      if (text.length > 100 || box.querySelector('video, .course_menu')) break;
      if (!/^(提示)?是否继续学习\?确定$/.test(text)) continue;
      const candidates = [...box.querySelectorAll('button, a, [role="button"], div, span, input')]
        .filter(el => visible(el) && clean(el.value || el.textContent) === '确定' &&
          ![...el.children].some(child => clean(child.textContent) === '确定'));
      if (candidates.length !== 1) continue;
      const leaf = candidates[0];
      const button = leaf.closest('button, a, [role="button"]');
      const target = button && box.contains(button) ? button : leaf;
      if (target.disabled || target.getAttribute('aria-disabled') === 'true') continue;
      return { key: box, click: () => target.click() };
    }
    return { key: message, click: null };
  }

  function getDetailStart() {
    const matches = [...document.querySelectorAll('button,a,div,span')]
      .filter(el => visible(el) && clean(el.textContent) === '开始学习' &&
        ![...el.children].some(child => clean(child.textContent) === '开始学习'));
    return matches.length === 1 ? matches[0] : null;
  }

  function readList() {
    const course = document.querySelector('.course');
    const rawRows = [...document.querySelectorAll('.course li.course_list')].filter(visible);
    const rows = rawRows.map(row => {
      const text = selector => clean(row.querySelector(selector)?.textContent);
      const title = row.querySelector('.course_list_right_title')?.textContent.trim() || '';
      const key = [clean(title), text('.course_list_right_person .name'),
        text('.course_list_right_timer .timer'), text('.course_list_right_state .state')].join('|');
      const progressText = row.querySelector('.el-progress__text')?.textContent || '';
      const percent = progressText.match(/(\d+(?:\.\d+)?)\s*%/);
      const candidates = [...row.querySelectorAll('.SaveButton .Save')]
        .filter(el => visible(el) && clean(el.textContent) === '开始学习');
      return {
        key, title, progress: percent ? Number(percent[1]) : null,
        element: candidates.length === 1 ? candidates[0] : null
      };
    });
    const pager = [...document.querySelectorAll('.el-pagination')].find(visible);
    const active = pager?.querySelector('.el-pager .number.active');
    const page = active ? Number(active.textContent.trim()) : 1;
    const totalText = pager?.querySelector('.el-pagination__total')?.textContent || '';
    const totalMatch = totalText.match(/共\s*(\d+)\s*条/);
    const total = totalMatch ? Number(totalMatch[1]) : null;
    const next = pager?.querySelector('.btn-next');
    const first = pager && [...pager.querySelectorAll('.el-pager .number')]
      .find(el => el.textContent.trim() === '1');
    const prev = pager?.querySelector('.btn-prev');
    const loading = [...document.querySelectorAll('.el-loading-mask')].some(visible);
    return {
      ready: Boolean(course && (rows.length > 0 || total === 0)),
      loading, page, rows, total,
      fingerprint: JSON.stringify(rows.map(row => row.key)),
      nextEnabled: Boolean(next && visible(next) && !next.disabled &&
        next.getAttribute('aria-disabled') !== 'true'),
      firstAvailable: Boolean(first || (prev && !prev.disabled))
    };
  }

  function scene() {
    const route = location.hash.slice(1).split('?')[0];
    if (route === '/study_center/my_course') {
      return { kind: 'list', id: '', url: location.href, list: readList() };
    }
    const parsed = parseCourseUrl(location.href, LIST_URL);
    if (!parsed) return { kind: 'other', id: '', url: location.href };
    const page = parsed.kind === 'video' ? readPage() : null;
    return {
      ...parsed,
      title: document.querySelector('.course_list_right_title')?.textContent.trim() ||
        document.querySelector('.video_box')?.previousElementSibling?.textContent.trim().slice(0,300) || '',
      mediaError: page?.video.error?.code || null,
      mediaReady: Boolean(page?.video.readyState >= 1 && page.source),
      hasVideo: Boolean(page?.video),
      hasChapters: Boolean(page?.items.length && page.index >= 0),
      canEnterDetail: parsed.kind === 'detail' && Boolean(getDetailStart())
    };
  }

  function cancelCapture() {
    if (captureCleanup) captureCleanup();
  }

  // 只在点击本站“开始学习”的短暂期间接管 window.open。
  // 捕获本站生成的真实课程 URL 后由调度器决定是否在当前页进入。
  function captureStart(element, onURL, onError) {
    cancelCapture();
    const target = element || getDetailStart();
    if (!target || !visible(target)) {
      onError('没有找到唯一的“开始学习”按钮');
      return;
    }
    let consumed = false;
    const originalOpen = window.open;
    let timer = null;
    const cleanup = () => {
      consumed = true;
      if (window.open === interceptedOpen) window.open = originalOpen;
      if (timer !== null) clearTimeout(timer);
      if (captureCleanup === cleanup) captureCleanup = null;
    };
    const fail = message => {
      if (consumed) return;
      consumed = true;
      cleanup();
      onError(message);
    };
    const deliver = raw => {
      if (consumed) return window;
      if (!scheduler.running || !lockHeld) {
        consumed = true;
        cleanup();
        return null;
      }
      const parsed = parseCourseUrl(raw, LIST_URL);
      if (!parsed) {
        fail('“开始学习”未返回已识别的本站课程网址，已停止');
        return null;
      }
      consumed = true;
      cleanup();
      onURL(parsed.url);
      return window;
    };
    function interceptedOpen(raw) { return deliver(raw); }
    captureCleanup = cleanup;

    const anchor = target.closest('a[href]');
    if (anchor && parseCourseUrl(anchor.href, LIST_URL)) {
      deliver(anchor.href);
      return;
    }
    try {
      window.open = interceptedOpen;
      if (window.open !== interceptedOpen) throw new Error('OpenHookUnavailable');
      timer = setTimeout(() => fail('未能接管课程的新标签页入口，已停止'), 20000);
      target.click();
    } catch {
      fail('无法执行课程入口操作，已停止');
    }
  }

  function pauseAll() {
    for (const video of document.querySelectorAll('.video_box .player video')) {
      try { video.pause(); } catch {}
    }
  }

  function saveSession(state) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, session: state, options }));
  }

  const host = document.createElement('div');
  host.id = PANEL_ID;
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{all:initial}*{box-sizing:border-box}
      section{width:282px;padding:15px;color:#202630;background:#fff;border:1px solid #dce2ea;
        border-radius:12px;box-shadow:0 6px 25px #0003;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif}
      header{display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:700}
      button{font:inherit;cursor:pointer;border:0;border-radius:7px}
      #fold,#reset{background:#eef1f5;color:#485366;padding:3px 9px}
      #toggle{width:100%;background:#c90018;color:white;padding:9px;margin:10px 0}
      #toggle.running{background:#3e495b}label{display:block;margin:5px 0;cursor:pointer}
      input{vertical-align:middle;accent-color:#c90018}#status{margin:10px 0 0;color:#334155;overflow-wrap:anywhere}
      small{display:block;color:#677386;font-size:11px;margin:9px 0}
      #count{font-size:12px;color:#677386;margin-top:5px}button:disabled{opacity:.5;cursor:default}
      #failureList{max-height:150px;overflow:auto;font-size:12px;overflow-wrap:anywhere}details{margin-top:8px}summary{cursor:pointer}
      [hidden]{display:none!important}
    </style>
    <section>
      <header>辽宁课程连播 · v2.2<button id="fold" title="收起或展开">−</button></header>
      <div id="body">
        <button id="toggle">开启连播</button>
        <label><input id="muted" type="checkbox"> 静音播放</label>
        <label><input id="confirm" type="checkbox"> 自动确认“是否继续学习”</label>
        <label><input id="crossCourse" type="checkbox"> 整门播完自动学习下一门</label>
        <small>自动切章节、切课程和翻页，失败课程本轮跳过。暂停请点“停止连播”。学时以网站记录为准。</small>
        <button id="reset">清空本轮记录（含失败课程）</button>
      </div>
      <div id="status">在未完成课程列表或视频页，点击开启连播。</div>
      <div id="count">本轮播至末尾：0 门</div>
      <details id="failures" hidden><summary>查看失败课程</summary><div id="failureList"></div></details>
    </section>`;
  document.body.appendChild(host);
  const statusEl = shadow.getElementById('status');
  const toggle = shadow.getElementById('toggle');
  const resetButton = shadow.getElementById('reset');
  function renderStatus(text, running, count = scheduler?.snapshot.doneIds?.length || 0) {
    if (statusEl.textContent !== text) statusEl.textContent = text;
    toggle.textContent = running ? '停止连播' : '开启连播';
    toggle.classList.toggle('running', running);
    resetButton.disabled = Boolean(running || acquiring);
    const failed = scheduler?.snapshot.failed || [];
    shadow.getElementById('count').textContent = '本轮播至末尾：' + count + ' 门；失败跳过：' + failed.length + ' 门';
    shadow.getElementById('failures').hidden = failed.length === 0;
    const failureList = shadow.getElementById('failureList');
    const summary = failed.map(item => (item.title || item.id) + '：' + item.reason).join('\n');
    if (failureList.textContent !== summary) {
      failureList.textContent = summary;
      failureList.style.whiteSpace = 'pre-wrap';
    }
  }

  const controller = createController({
    options, now: () => Date.now(), read: readPage, findPrompt: findContinuePrompt,
    status(text) {
      videoStatus = text;
      if (scheduler?.running && scheduler.snapshot.phase === 'playing') {
        renderStatus(text, true);
      }
    },
    play: video => video.play(),
    pause: video => { try { video.pause(); } catch {} },
    mute: (video, muted) => { if (video.muted !== muted) video.muted = muted; },
    next(page, index) {
      if (!scheduler?.running || !lockHeld) throw new Error('RunStopped');
      const item = page.items[index];
      if (!item?.isConnected || !visible(item) || item.getAttribute('aria-disabled') === 'true' ||
          item.classList.contains('disabled')) throw new Error('ChapterUnavailable');
      (item.querySelector('span') || item).click();
    }
  });

  const loadingPromptGate = createContinueGate({
    options, now: () => Date.now(), findPrompt: findContinuePrompt
  });
  scheduler = createCourseScheduler({
    options, now: () => Date.now(), scene, player: controller, listURL: LIST_URL,
    online: () => navigator.onLine,
    refreshOnStart: true,
    handleLoadingPrompt: () => loadingPromptGate.check(),
    save: saveSession,
    status: renderStatus,
    pauseAll,
    captureStart, cancelCapture,
    navigate(url) {
      if (!lockHeld || !scheduler.running) throw new Error('RunStopped');
      if (url !== LIST_URL && !parseCourseUrl(url, LIST_URL)) throw new Error('InvalidDestination');
      documentNavigating = true;
      try {
        navigateFresh(url, {
          href: location.href,
          replaceURL: target => history.replaceState(history.state, '', target),
          reload: () => location.reload(),
          assign: target => location.assign(target)
        });
      } catch (error) {
        documentNavigating = false;
        throw error;
      }
    },
    nextPage() {
      if (!lockHeld || !scheduler.running) throw new Error('RunStopped');
      const pager = [...document.querySelectorAll('.el-pagination')].find(visible);
      const next = pager?.querySelector('.btn-next');
      if (!next || next.disabled) throw new Error('NoNextPage');
      next.click();
    },
    firstPage() {
      if (!lockHeld || !scheduler.running) throw new Error('RunStopped');
      const pager = [...document.querySelectorAll('.el-pagination')].find(visible);
      const first = pager && [...pager.querySelectorAll('.el-pager .number')]
        .find(el => el.textContent.trim() === '1');
      const prev = pager?.querySelector('.btn-prev');
      if (first) first.click();
      else if (prev && !prev.disabled) prev.click();
      else throw new Error('NoFirstPage');
    },
    onStopped() {
      lockRequest++;
      acquiring = false;
      cancelCapture();
      releaseLock?.();
    }
  }, saved.version === 2 ? saved.session : undefined);

  async function acquireAndStart(resume = false) {
    if (scheduler.running || acquiring) return;
    if (!navigator.locks?.request) {
      renderStatus('当前浏览器无法协调多个标签页，请使用支持 Web Locks 的浏览器', false);
      return;
    }
    const request = ++lockRequest;
    acquiring = true;
    renderStatus('正在准备连播…', true);
    try {
      await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
        if (request !== lockRequest) return;
        acquiring = false;
        if (!lock) {
          scheduler.stop('另一个标签页正在连播，请在那个面板操作');
          return;
        }
        lockHeld = true;
        const held = new Promise(resolve => { releaseLock = resolve; });
        try {
          if (resume) scheduler.resume();
          else scheduler.start();
          if (!scheduler.running) releaseLock();
          await held;
        } finally {
          lockHeld = false;
          releaseLock = null;
        }
      });
    } catch {
      if (request === lockRequest) scheduler.stop('未能启动连播，请刷新后重试');
    } finally {
      if (request === lockRequest) acquiring = false;
    }
  }

  toggle.addEventListener('click', () => {
    if (scheduler.running || acquiring) {
      lockRequest++;
      acquiring = false;
      scheduler.stop('已停止，视频已暂停');
    } else void acquireAndStart(false);
  });
  resetButton.addEventListener('click', () => {
    if (!scheduler.running && !acquiring) scheduler.reset();
  });
  for (const name of ['muted', 'confirm', 'crossCourse']) {
    const input = shadow.getElementById(name);
    input.checked = options[name];
    input.addEventListener('change', event => {
      options[name] = event.target.checked;
      if (name === 'muted' && observedVideo && scheduler.running) observedVideo.muted = options.muted;
      try { saveSession(scheduler.snapshot); }
      catch { scheduler.stop('无法保存连播状态，已停止'); }
    });
  }
  shadow.getElementById('fold').addEventListener('click', event => {
    const body = shadow.getElementById('body');
    body.hidden = !body.hidden;
    event.target.textContent = body.hidden ? '+' : '−';
  });

  setInterval(() => {
    if (!lockHeld || !scheduler.running || documentNavigating) return;
    scheduler.tick();
  }, 1000);

  window.addEventListener('pagehide', () => {
    // 控制器暂停与跨页开关分离：脚本发起的页面跳转保留连播状态。
    const snapshot = scheduler.snapshot;
    const expected = snapshot.enabled && snapshot.navIntent;
    if (!expected) {
      scheduler.stop('页面已离开，连播已停止');
    } else {
      try { saveSession(snapshot); } catch {}
      cancelCapture();
      controller.stop('正在切换页面…', 'suspended');
      releaseLock?.();
    }
  });

  window.addEventListener('pageshow', event => {
    if (event.persisted) scheduler.stop('历史页面已恢复，连播已停止，可在面板重新开启');
  });

  if (saved.version === 2 && saved.session?.enabled) {
    void acquireAndStart(true);
  } else {
    renderStatus('在未完成课程列表或视频页，点击开启连播。', false);
  }
})();
