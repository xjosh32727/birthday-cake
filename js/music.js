/* ============================================================
 * music.js —— 魔法赛博生日蛋糕 · 音乐播放器
 * ------------------------------------------------------------
 * 这个文件负责三件事：
 *   1. 用 Web Audio API "现场合成"八音盒版《生日快乐》
 *      （不需要任何音频文件，相当于给浏览器装了一个音乐盒机芯）
 *   2. 在左下角画出一个霓虹胶囊播放器：播放/暂停、曲名、选歌列表
 *   3. 探测 audio/ 文件夹里有没有 after17.mp3 / 22.mp3：
 *      有 → 解锁可点播；没有 → 置灰 + 一句友好提示
 *
 * 播放器长这样（屏幕左下角的小胶囊，不挡蛋糕）：
 *   ┌────────────────────────────────┐
 *   │  (⏸) 🎵 生日快乐 · 八音盒版 (🎶) │
 *   └────────────────────────────────┘
 *   ⏸ = 播放/暂停      🎶 = 打开/收起选歌列表
 *
 * 对外只暴露一个对象 window.MusicPlayer（别的都是"内部零件"）：
 *   - MusicPlayer.autoplay()       进入场景后调用：亮出播放器并开播八音盒
 *   - MusicPlayer.onExplode(true)  蛋糕炸开时调用：撒一把星星音效 ✨
 *
 * 本文件不依赖任何第三方库，断网 / file:// 双击打开都不会报错。
 * ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     一、可调参数区（想改行为，先改这里）
     ============================================================ */

  /* —— 乐谱：生日快乐歌（C 大调，比原曲高一个八度，更像音乐盒）——
     每个音符写成 { midi: 音高, beats: 拍数 }：
     · midi 是音高的"门牌号"：+1 = 高半音，+12 = 高一个八度。
       本曲用到的：G5=79  A5=81  B5=83  C6=84  D6=86  E6=88  F6=89  G6=91
     · beats 是这个音持续几拍：1 = 四分音符，2 = 二分音符，
       0.75 = 附点八分音符、0.25 = 十六分音符（每句开头那一对"哒-哒"）。
     想换曲子？把这个数组换成新旋律就行，别的代码都不用动。 */
  var SCORE = [
    /* 第 1 句：sol sol la sol do' si  —— 祝你 生日快乐 */
    { midi: 79, beats: 0.75 }, { midi: 79, beats: 0.25 },
    { midi: 81, beats: 1 }, { midi: 79, beats: 1 },
    { midi: 84, beats: 1 }, { midi: 83, beats: 2 },
    /* 第 2 句：sol sol la sol re' do' —— 祝你 生日快乐 */
    { midi: 79, beats: 0.75 }, { midi: 79, beats: 0.25 },
    { midi: 81, beats: 1 }, { midi: 79, beats: 1 },
    { midi: 86, beats: 1 }, { midi: 84, beats: 2 },
    /* 第 3 句：sol sol sol' mi' do' si la —— 祝你 亲爱的~（全曲最高点） */
    { midi: 79, beats: 0.75 }, { midi: 79, beats: 0.25 },
    { midi: 91, beats: 1 }, { midi: 88, beats: 1 },
    { midi: 84, beats: 1 }, { midi: 83, beats: 1 }, { midi: 81, beats: 2 },
    /* 第 4 句：fa' fa' mi' do' re' do' —— 祝你 生日 快乐（收尾拖长 3 拍） */
    { midi: 89, beats: 0.75 }, { midi: 89, beats: 0.25 },
    { midi: 88, beats: 1 }, { midi: 84, beats: 1 },
    { midi: 86, beats: 1 }, { midi: 84, beats: 3 }
  ];

  var BEAT_SECONDS = 0.42;     // 一拍多少秒：数字越小节奏越快。想欢快些改成 0.36 试试
  var LOOP_GAP_SECONDS = 2;    // 整曲唱完休息 2 秒再重播，像音乐盒"上发条"的空档

  /* —— 八音盒音色配方 ——
     真实音乐盒的钢片被拨动时，不只有基音，还叠着几层更高的泛音；
     而且每个音都是"叮"地一下快速亮起，再慢慢散掉（指数衰减）。
     下面每一行就是一层泛音：
       ratio = 频率是基音的几倍（2 = 高八度，4 = 高两个八度；
               6.5 是个故意"不准"的超高频，短促的一下 → 金属"叮"感）
       gain  = 这层有多响（相对音量，越大越明显）
       decay = 几秒内衰减到几乎听不见（越长余音越悠扬）
     想更"空灵"：把第 2 层的 gain 调大；想更"清脆"：把 decay 都调短。 */
  var PARTIALS = [
    { ratio: 1,   gain: 1.00, decay: 2.4 },  // 基音：声音的主体
    { ratio: 2,   gain: 0.35, decay: 1.5 },  // 高八度：增加亮度
    { ratio: 4,   gain: 0.12, decay: 0.8 },  // 高两个八度：增加"灵气"
    { ratio: 6.5, gain: 0.05, decay: 0.25 }  // 超高频"叮"：金属感，很短促
  ];
  var ATTACK_SECONDS = 0.005;  // 起音时间：5 毫秒内冲到最响，像拨片"弹"了一下钢片
  var NOTE_VOLUME = 0.20;      // 每个音的峰值音量（多个音的余音会叠加，别调太大，会破音）
  var BOX_MASTER_VOLUME = 0.9; // 音乐盒的总音量

  /* —— 炸开彩蛋：几个快速上行的高音，像撒了一把星星 —— */
  var SPARKLE_NOTES = [96, 100, 103, 108]; // C7 E7 G7 C8，一闪而过的上行琶音
  var SPARKLE_STEP = 0.07;                 // 每颗"星星"之间隔 0.07 秒

  /* —— 曲目表 ——
     type='box'：现场合成的八音盒，永远可用；
     type='mp3'：两首"卡槽歌"，初始化时会探测文件是否存在，
                 存在才解锁（locked 改成 false），否则保持置灰。 */
  var TRACKS = [
    { id: 'box',     type: 'box', icon: '🎵', name: '生日快乐 · 八音盒版', locked: false },
    { id: 'after17', type: 'mp3', icon: '🎧', name: 'After 17 - 陈绮贞', src: 'audio/after17.mp3', file: 'after17.mp3', locked: true },
    { id: 'song22',  type: 'mp3', icon: '🎧', name: '二十二 - 陶喆',     src: 'audio/22.mp3',      file: '22.mp3',      locked: true }
  ];

  /* ============================================================
     二、内部状态（这些变量记着播放器"现在到哪了"）
     ============================================================ */
  var initialized = false;    // UI 是否已经建好（防止重复建两遍）
  var container = null;       // 页面上的 #music-player 占位 div
  var playBtn = null;         // 播放/暂停按钮
  var nameEl = null;          // 曲名显示
  var listEl = null;          // 选歌列表面板
  var toastEl = null;         // 小气泡提示
  var toastTimer = null;      // 小气泡自动消失的计时器

  var state = {
    currentTrackId: 'box',    // 当前选中哪首歌（默认八音盒）
    playing: false            // 当前是否正在出声
  };

  /* Web Audio 相关的"零件"：
     boxCtx  = 音频上下文（相当于音乐盒的"电源总开关"）
     boxGain = 音乐盒的总音量旋钮（暂停时把它拧到 0，余音会快速散去）
     boxPlaying / loopTimer = 循环播放用的开关和计时器 */
  var boxCtx = null;
  var boxGain = null;
  var boxPlaying = false;
  var loopTimer = null;

  var audioEl = null;         // 播 mp3 用的播放器（HTMLAudioElement），要用时才创建
  var playingMp3Id = null;    // 当前装进"卡槽"的是哪首 mp3

  /* ============================================================
     三、样式（用 JS 注入 <style>，不动别人的 css 文件）
     ------------------------------------------------------------
     所有 class 都带 mp- 前缀，像给零件贴上"音乐播放器专用"标签，
     不会和 style.css 里的样式打架。配色沿用全局的青 #0ff / 品红 #f0f。
     ============================================================ */
  var CSS_TEXT = [
    /* 胶囊主条：半透明黑底 + 青色描边 + 双层发光 */
    '.mp-bar{display:flex;align-items:center;gap:8px;padding:6px 12px 6px 6px;',
    'background:rgba(10,10,22,.78);border:1px solid rgba(0,255,255,.5);border-radius:999px;',
    'box-shadow:0 0 14px rgba(0,255,255,.35),0 0 34px rgba(255,0,255,.16),inset 0 0 12px rgba(0,255,255,.08);',
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
    /* 圆形按钮：44x44，手机上"手指好按"的最小尺寸 */
    '.mp-btn{flex:none;width:44px;height:44px;padding:0;border-radius:50%;cursor:pointer;',
    'display:flex;align-items:center;justify-content:center;font:inherit;font-size:18px;',
    'color:#0ff;background:rgba(0,255,255,.06);border:1px solid rgba(0,255,255,.6);',
    'text-shadow:0 0 8px rgba(0,255,255,.8);-webkit-tap-highlight-color:transparent;',
    'transition:box-shadow .2s,background .2s,transform .1s;}',
    '.mp-btn:hover{background:rgba(0,255,255,.14);box-shadow:0 0 16px rgba(0,255,255,.6);}',
    '.mp-btn:active{transform:scale(.94);}',
    /* 曲名：太长就省略号，别把胶囊撑爆 */
    '.mp-name{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-size:13px;color:#fff;text-shadow:0 0 8px rgba(0,255,255,.6);}',
    /* 选歌列表：从胶囊"头顶"向上弹出 */
    '.mp-list{position:absolute;left:0;bottom:calc(100% + 10px);display:none;flex-direction:column;gap:6px;',
    'min-width:230px;padding:8px;border-radius:14px;',
    'background:rgba(10,10,22,.9);border:1px solid rgba(0,255,255,.45);',
    'box-shadow:0 0 18px rgba(0,255,255,.3);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
    '.mp-list.mp-open{display:flex;}',
    '.mp-item{min-height:44px;display:flex;align-items:center;padding:8px 12px;border-radius:10px;',
    'font:inherit;font-size:13px;text-align:left;cursor:pointer;color:#fff;',
    'background:rgba(0,0,0,.45);border:1px solid rgba(0,255,255,.35);-webkit-tap-highlight-color:transparent;}',
    '.mp-item:hover{background:rgba(0,255,255,.1);box-shadow:0 0 12px rgba(0,255,255,.4);}',
    /* 正在播的那首：描边变品红，一眼认出"现在是它" */
    '.mp-item.mp-active{border-color:#f0f;color:#f0f;text-shadow:0 0 8px rgba(255,0,255,.8);',
    'box-shadow:0 0 12px rgba(255,0,255,.45);}',
    /* 没解锁的歌：变灰 + 禁用手型，告诉用户"还差一步" */
    '.mp-item.mp-locked{opacity:.45;cursor:not-allowed;}',
    '.mp-item.mp-locked:hover{background:rgba(0,0,0,.45);box-shadow:none;}',
    /* 小气泡提示：也是往头顶弹，2.6 秒自己消失 */
    '.mp-toast{position:absolute;left:0;bottom:calc(100% + 10px);max-width:260px;padding:10px 14px;',
    'border-radius:12px;font-size:13px;line-height:1.6;color:#fff;pointer-events:none;',
    'background:rgba(10,10,22,.94);border:1px solid rgba(255,0,255,.55);',
    'box-shadow:0 0 16px rgba(255,0,255,.35);opacity:0;transform:translateY(6px);',
    'transition:opacity .25s,transform .25s;}',
    '.mp-toast.mp-show{opacity:1;transform:none;}',
    /* 手机端：曲名再收窄一点，整体不挡屏幕中心 */
    '@media (max-width:600px){.mp-name{max-width:104px;font-size:12px;}.mp-list{min-width:200px;}}'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('mp-styles')) return; // 已经插过就别重复插
    var styleEl = document.createElement('style');
    styleEl.id = 'mp-styles';
    styleEl.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  /* ============================================================
     四、八音盒机芯（Web Audio 现场合成）
     ============================================================ */

  /* 懒加载创建音频上下文：浏览器规定必须等用户点过页面才允许出声，
     所以不在一打开网页就建，而是等 autoplay()/点击播放时才建。
     返回 true = 电源接上了；false = 这个浏览器不支持，静默降级 */
  function ensureBoxCtx() {
    if (boxCtx) { tryResumeCtx(); return true; }
    try {
      var AC = window.AudioContext || window.webkitAudioContext; // webkit 前缀：兼容老 Safari
      if (!AC) return false;
      boxCtx = new AC();
      /* 总音量旋钮：所有音符先经过它再出声。
         暂停时把它拧到 0，正在响的余音会快速散去，不用逐个追停 */
      boxGain = boxCtx.createGain();
      boxGain.gain.value = BOX_MASTER_VOLUME;
      boxGain.connect(boxCtx.destination);
      tryResumeCtx();
      return true;
    } catch (e) {
      boxCtx = null;
      boxGain = null;
      return false;
    }
  }

  /* 浏览器有时会把音频上下文"冻住"（suspended），常见于还没收到用户手势时。
     这里温柔地唤醒它；resume() 返回 Promise，兜住拒绝，不让控制台飘红 */
  function tryResumeCtx() {
    if (!boxCtx || boxCtx.state !== 'suspended') return;
    try {
      var p = boxCtx.resume();
      if (p && typeof p.catch === 'function') p.catch(function () { /* 稍后有点击还会再试 */ });
    } catch (e) { /* 静默 */ }
  }

  /* midi 门牌号 → 频率（赫兹）。69 号 = 标准音 A4 = 440Hz，
     每高 12 号频率翻倍（高一个八度），这是乐理的数学公式 */
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /* 弹响一个音：按 PARTIALS 配方叠几层正弦波，每层都是
     "5ms 内冲到最响 → 按各自 decay 指数衰减到听不见"，叠起来就是八音盒的"叮——" */
  function playNote(midi, when) {
    var freq = midiToFreq(midi);
    PARTIALS.forEach(function (p) {
      var osc = boxCtx.createOscillator(); // 振荡器：发声的"钢片"
      var gain = boxCtx.createGain();      // 增益：这片钢片的"音量包络"
      osc.type = 'sine';                   // 正弦波最纯，像音乐盒；换成 'triangle' 会更亮一点
      osc.frequency.value = freq * p.ratio;
      var peak = NOTE_VOLUME * p.gain;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(peak, when + ATTACK_SECONDS);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + p.decay);
      osc.connect(gain);
      gain.connect(boxGain);
      osc.start(when);
      osc.stop(when + p.decay + 0.05);     // 衰减完就回收，不占资源
    });
  }

  /* 循环发动机：把整首曲子的所有音符一次性"排进日程表"（提前排好不会卡），
     排完后定一个闹钟：曲终 + 休息 2 秒 → 再排下一遍，如此循环 */
  function scheduleLoop() {
    if (!boxPlaying || !boxCtx) return;
    if (boxCtx.state !== 'running') {
      /* 声音被浏览器冻住时（比如页面切后台），别把音符往冻结的时间线上堆，
         等它解冻再排；顺便再试着唤醒一次 */
      tryResumeCtx();
      loopTimer = setTimeout(scheduleLoop, 400);
      return;
    }
    var t = boxCtx.currentTime + 0.08; // 留 80ms 准备时间，避免第一个音被"咬掉"
    SCORE.forEach(function (n) {
      playNote(n.midi, t);
      t += n.beats * BEAT_SECONDS;
    });
    loopTimer = setTimeout(scheduleLoop, (t - boxCtx.currentTime + LOOP_GAP_SECONDS) * 1000);
  }

  /* 开始放八音盒（从头播）。返回 false = 这个浏览器合成不了 */
  function startBox() {
    if (!ensureBoxCtx()) {
      toast('你的浏览器不支持现场合成音乐 😢 可以试试 mp3 卡槽里的歌');
      return false;
    }
    clearTimeout(loopTimer);
    boxPlaying = true;
    var now = boxCtx.currentTime;
    boxGain.gain.cancelScheduledValues(now);
    boxGain.gain.setValueAtTime(BOX_MASTER_VOLUME, now); // 恢复总音量（上次暂停被拧到了 0）
    scheduleLoop();
    return true;
  }

  /* 暂停八音盒 = 停止循环 + 总音量快速拧到 0（余音像被盖上盖子一样散去）。
     恢复时从头重新播，简单可靠。 */
  function stopBox() {
    boxPlaying = false;
    clearTimeout(loopTimer);
    if (boxCtx && boxGain) {
      var now = boxCtx.currentTime;
      boxGain.gain.cancelScheduledValues(now);
      boxGain.gain.setTargetAtTime(0, now, 0.08); // 0.08s 时间常数：快速但不"咔嚓"
    }
  }

  /* 炸开彩蛋：快速上行的高音琶音，像"哗"地撒出一把星星。
     注意它直接连 destination，不经过 boxGain —— 就算正在放 mp3，星星也照撒 */
  function playSparkle() {
    if (!boxCtx || boxCtx.state !== 'running') return; // 没有出声环境就不撒
    var t0 = boxCtx.currentTime + 0.03;
    SPARKLE_NOTES.forEach(function (midi, i) {
      var when = t0 + i * SPARKLE_STEP;
      var freq = midiToFreq(midi);
      [{ r: 1, g: 0.10, d: 0.7 }, { r: 4, g: 0.05, d: 0.3 }].forEach(function (p) {
        var osc = boxCtx.createOscillator();
        var gain = boxCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * p.r;
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(p.g, when + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + p.d);
        osc.connect(gain);
        gain.connect(boxCtx.destination);
        osc.start(when);
        osc.stop(when + p.d + 0.05);
      });
    });
  }

  /* ============================================================
     五、mp3 卡槽（HTMLAudioElement 播真实音频文件）
     ============================================================ */

  /* 懒创建 mp3 播放器：只有一个，谁被选中就"插"谁的文件进去 */
  function ensureAudioEl() {
    if (audioEl) return audioEl;
    if (typeof Audio !== 'function') return null; // 老到没有 Audio 的浏览器：静默放弃
    try {
      audioEl = new Audio();
      audioEl.loop = true;      // 卡槽的歌单曲循环，派对气氛不断电
      audioEl.preload = 'auto';
      /* 文件损坏 / 格式不支持时会触发 error：
         把这歌重新锁上并提示，别让它反复报错 */
      audioEl.addEventListener('error', function () {
        var t = getCurrentTrack();
        if (t.type !== 'mp3') return;
        t.locked = true;
        state.playing = false;
        toast('这首歌好像读不出来 😢 检查一下 ' + t.file + ' 是不是完整的 mp3');
        renderList();
        updateHeader();
      });
      return audioEl;
    } catch (e) {
      audioEl = null;
      return null;
    }
  }

  function playMp3(track) {
    var el = ensureAudioEl();
    if (!el) { toast('你的浏览器播不了 mp3 😢'); return false; }
    stopBox(); // 插卡前先把音乐盒的发条松掉，两种声音不打架
    if (playingMp3Id !== track.id) {
      el.src = track.src;       // 换歌 = 换一张"卡带"
      playingMp3Id = track.id;
    }
    var p = el.play();
    /* play() 返回 Promise：个别浏览器会拦自动播放，兜住并给用户一个可操作的提示 */
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        state.playing = false;
        updateHeader();
        toast('浏览器拦了一下自动播放，再点一次播放键试试 👆');
      });
    }
    return true;
  }

  function pauseMp3() {
    if (audioEl) audioEl.pause();
  }

  /* ============================================================
     六、切歌总调度（八音盒和 mp3 之间的"红绿灯"）
     ============================================================ */

  function getCurrentTrack() {
    for (var i = 0; i < TRACKS.length; i++) {
      if (TRACKS[i].id === state.currentTrackId) return TRACKS[i];
    }
    return TRACKS[0];
  }

  /* 开播指定曲目；返回是否真的响起来了 */
  function startTrack(track) {
    var ok;
    if (track.type === 'box') {
      pauseMp3();
      ok = startBox();
    } else {
      ok = playMp3(track); // playMp3 内部会 stopBox()
    }
    state.playing = ok;
    updateHeader();
    return ok;
  }

  /* 播放/暂停按钮：对"当前这首"做开关 */
  function onTogglePlay() {
    var track = getCurrentTrack();
    if (state.playing) {
      if (track.type === 'box') stopBox(); else pauseMp3();
      state.playing = false;
      updateHeader();
    } else {
      startTrack(track);
    }
  }

  /* 点选歌列表里的某一首 */
  function onSelectTrack(track) {
    closeList(); // 选完（或看完提示）就把列表收起来，也避免提示气泡和列表叠在一起
    if (track.locked) {
      toast('把 ' + track.file + ' 放进 audio 文件夹就能解锁这首歌 🎁');
      return;
    }
    if (track.id === state.currentTrackId) {
      if (!state.playing) startTrack(track); // 点"正在选的这首"= 继续播放
      return;
    }
    /* 换歌：先停旧的，再播新的 */
    stopBox();
    pauseMp3();
    state.currentTrackId = track.id;
    startTrack(track);
    renderList(); // 刷新列表里的"正在播放"高亮
  }

  /* ============================================================
     七、卡槽探测：看看 audio/ 里到底有没有那两首 mp3
     ------------------------------------------------------------
     做法是发一个 HEAD 请求"敲门"：门开了（2xx）= 文件存在，解锁；
     404 / 网络异常 / file:// 协议下 fetch 直接失败 → 都当作"不存在"，静默容错。
     ============================================================ */
  function probeFile(url, onDone) {
    if (typeof window.fetch !== 'function') { onDone(false); return; }
    try {
      /* cache:'no-store'：刚把 mp3 拖进文件夹就刷新，不会读到旧缓存的 404 */
      window.fetch(url, { method: 'HEAD', cache: 'no-store' })
        .then(function (res) { onDone(!!(res && res.ok)); })
        .catch(function () { onDone(false); }); // file:// 双击打开时会走到这里，属正常
    } catch (e) {
      onDone(false);
    }
  }

  function detectSlots() {
    TRACKS.forEach(function (track) {
      if (track.type !== 'mp3') return;
      probeFile(track.src, function (exists) {
        track.locked = !exists;
        renderList(); // 探测结果一回来就刷新列表的锁/解锁状态
      });
    });
  }

  /* ============================================================
     八、UI：把播放器画进 #music-player 占位容器
     ============================================================ */

  /* 小气泡提示：弹出来 2.6 秒自动消失 */
  function toast(msg) {
    if (!toastEl) return; // UI 还没建好时（极少见），静默跳过
    toastEl.textContent = msg;
    toastEl.classList.add('mp-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('mp-show'); }, 2600);
  }

  function closeList() {
    if (listEl) listEl.classList.remove('mp-open');
  }

  /* 刷新胶囊上的"曲名 + 播放键图标" */
  function updateHeader() {
    if (!playBtn || !nameEl) return;
    var track = getCurrentTrack();
    nameEl.textContent = track.icon + ' ' + track.name;
    playBtn.textContent = state.playing ? '⏸' : '▶';
    playBtn.title = state.playing ? '暂停' : '播放';
  }

  /* 重画选歌列表：锁着的置灰带 🔒，正在播的描边变品红 */
  function renderList() {
    if (!listEl) return;
    listEl.innerHTML = '';
    TRACKS.forEach(function (track) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'mp-item';
      if (track.locked) item.className += ' mp-locked';
      if (track.id === state.currentTrackId) item.className += ' mp-active';
      item.textContent = (track.locked ? '🔒 ' : track.icon + ' ') + track.name;
      item.title = track.locked ? ('文件还没放进 audio 文件夹') : ('播放：' + track.name);
      /* 闭包锁住 track：点哪一行，就处理哪一首 */
      item.addEventListener('click', function () { onSelectTrack(track); });
      listEl.appendChild(item);
    });
  }

  function buildUI() {
    container.innerHTML = '';

    toastEl = document.createElement('div');
    toastEl.className = 'mp-toast';
    container.appendChild(toastEl);

    listEl = document.createElement('div');
    listEl.className = 'mp-list';
    container.appendChild(listEl);

    var bar = document.createElement('div');
    bar.className = 'mp-bar';

    playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'mp-btn';
    playBtn.textContent = '▶';
    playBtn.title = '播放';
    playBtn.addEventListener('click', onTogglePlay);

    nameEl = document.createElement('span');
    nameEl.className = 'mp-name';

    var listBtn = document.createElement('button');
    listBtn.type = 'button';
    listBtn.className = 'mp-btn';
    listBtn.textContent = '🎶';
    listBtn.title = '选歌';
    listBtn.addEventListener('click', function () {
      listEl.classList.toggle('mp-open');
    });

    bar.appendChild(playBtn);
    bar.appendChild(nameEl);
    bar.appendChild(listBtn);
    container.appendChild(bar);

    /* 点页面其他地方时收起列表（点播放器自己不算） */
    document.addEventListener('click', function (e) {
      if (!listEl.classList.contains('mp-open')) return;
      if (container.contains(e.target)) return;
      closeList();
    });

    renderList();
    updateHeader();
  }

  /* ============================================================
     九、初始化：等 #music-player 出现 → 建样式、建 UI、探测卡槽
     ------------------------------------------------------------
     正常情况下脚本在 </body> 前执行，占位 div 已经在了；
     但万一加载顺序变了，就每 250ms 找一次，最多找 10 秒，找不到就安静放弃。
     ============================================================ */
  function init(el) {
    if (initialized) return;
    container = el;
    injectStyles();
    buildUI();
    detectSlots();
    initialized = true;
  }

  function ensureInit() {
    if (initialized) return true;
    var el = document.getElementById('music-player');
    if (!el) return false;
    try {
      init(el);
    } catch (e) {
      return false; // 建 UI 出问题也不拖垮整个页面
    }
    return true;
  }

  function boot() {
    var tries = 0;
    (function attempt() {
      if (ensureInit()) return;
      if (++tries < 40) setTimeout(attempt, 250);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ============================================================
     十、对外接口：window.MusicPlayer（别的场景代码只认这两个方法）
     ============================================================ */
  window.MusicPlayer = {
    /* 进入场景后由外部调用：亮出播放器 + 开播八音盒。
       此时已经有过用户手势（点了"进入魔法世界"），AudioContext 允许出声 */
    autoplay: function () {
      ensureInit();
      if (container) container.classList.remove('hidden');
      if (state.playing) return;                 // 已经在放了，不打扰
      if (state.currentTrackId !== 'box') return; // 用户自己选了别的歌，尊重他的选择
      startTrack(getCurrentTrack());
    },
    /* 蛋糕炸开/恢复时由外部调用：炸开那一下撒一把星星音效 */
    onExplode: function (exploded) {
      if (!exploded) return;
      playSparkle();
    }
  };
})();