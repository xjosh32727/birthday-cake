/* ============================================================
 * gesture.js —— MediaPipe 手势识别（张掌炸开 / 握拳恢复）
 * ------------------------------------------------------------
 * 这个文件负责四件事：
 *   1. 启动手势识别：用 CDN 引入的全局 Hands（大脑，负责看懂手），
 *      并自己写一条"帧循环传送带"，把 #cam-preview 的画面一帧帧喂给它。
 *
 *      【为什么不再用 MediaPipe 官方的 Camera 工具类？】
 *      Camera 内部会自己再调一次 getUserMedia 申请一路新摄像头流，
 *      并覆盖 video 的 srcObject —— 而 form.js 早就把用户授权的那路流
 *      挂在同一个 video 上了。两路流抢一个摄像头，很多浏览器（尤其手机）
 *      会直接让画面卡在第一帧/黑屏，hands.send 拿不到有效画面，
 *      onResults 永远不被调用 → 看起来就是"手势没反应"。
 *      所以改成手动帧循环：只读 form.js 接好的这一画面，不抢流。
 *
 *   2. 判定手势：只看 21 个关键点的几何关系，不依赖任何模型输出分类：
 *        张开手掌 ✋ → 炸开蛋糕
 *        握拳     ✊ → 恢复原样
 *        其他/看不清 → 保持现状（不乱动）
 *   3. 防抖 + 容错：连续 5 帧都是同一手势才生效（快速乱挥不会鬼畜）；
 *      模型加载失败就亮出手动按钮（Plan B 双保险）
 *   4. 状态指示灯：摄像头预览小窗上方的小胶囊（#gesture-status），
 *      像汽车仪表盘一样实时告诉用户"它看见我了没"：
 *        ✋ Open palm 绿点 / ✊ Fist 金点 / 👀 No hand 灰点 / 📷 Camera off 红点
 *
 * 对外只暴露一个函数（scene.js 会在进入场景时调用）：
 *   - window.startGestureRecognition(stream)
 *
 * 小知识：MediaPipe 会把一只手标成 21 个点，编号固定：
 *   0=手腕；每根手指 4 个点，从根到尖，比如食指是 5(根) 6 7 8(尖)，
 *   中指 9~12，无名指 13~16，小指 17~20。
 * ============================================================ */

(function () {
  'use strict';

  /* ============================================================
    一、可调参数区（想改灵敏度，先改这里）
    ============================================================ */

  /* 判定比例：指尖到手腕的距离 ÷ 指根到手腕的距离
     张开时这个比值大（手指伸直≈1.5~2 倍），握拳时小（指尖蜷缩≈0.7~1 倍）。
     想"更容易触发张掌"：把 1.3 调小一点（比如 1.2），但也更容易误判 */
  var OPEN_RATIO = 1.3;   // 大于它 = 这根手指算"伸直"
  var FIST_RATIO = 1.1;   // 小于它 = 这根手指算"蜷缩"
  var OPEN_MIN_FINGERS = 3; // 至少几根手指伸直才算"张掌"（4 根里允许 1 根没看清）

  /* 防抖参数：同一个手势要"连续出现这么多帧"才真的切换。
     类比：电梯门要按住按钮几秒才关，防止路人蹭一下就开关。
     想更灵敏：5 改成 3；想更稳重：改成 7 */
  var FRAMES_TO_CONFIRM = 5;
  var COOLDOWN_MS = 500;      // 每次切换后的"冷静时间"，防止一次挥手触发两次

  /* 容错时间：等 video 出画面最多 5 秒；模型 10 秒没反应就亮手动按钮 */
  var VIDEO_READY_TIMEOUT_MS = 5000;
  var WATCHDOG_MS = 10000;

  /* ============================================================
    二、内部状态
    ============================================================ */
  var started = false;            // 单例锁：只启动一次
  var hands = null;               // MediaPipe 的"大脑"
  var video = null;               // #cam-preview 视频元素（form.js 已把授权流挂上去）
  var fallbackShownByUs = false;  // 手动按钮是不是我们亮出来的（是的话恢复时要收回去）

  /* 防抖用的计数器 */
  var candidate = 'unknown';      // 正在"候选"的手势（还没坐实）
  var candidateFrames = 0;        // 它已经连续出现几帧了
  var currentGesture = null;      // 当前已生效的手势（'open' / 'fist'）
  var lastSwitchAt = 0;           // 上次切换的时刻（算冷静期用）

  var watchdogTimer = null;       // 看门狗：模型 10 秒没反应就亮手动按钮
  var consecutiveErrors = 0;      // 连续送帧失败次数（防止模型崩了还硬撑）

  /* 帧循环相关 */
  var loopRunning = false;        // 帧循环总开关（启动后一直转，除非页面不可见）
  var sending = false;            // 串行闸门：上一帧没分析完，绝不送下一帧（防堆积）
  var rafScheduled = false;       // 防止同一时刻向浏览器排多个"下一帧"，避免循环开岔
  var firstHandLogged = false;    // '[gesture] hand detected' 只报一次，不刷屏

  /* 指示灯相关 */
  var indicatorEl = null;         // 胶囊本体（#gesture-status）
  var indicatorTextEl = null;     // 胶囊里的文字

  /* ============================================================
    三、手势判定：纯几何，像用尺子量手指
    ------------------------------------------------------------
    思路：手指伸直时，"指尖"一定比"指根"离手腕远得多；
    握拳时，指尖蜷回来，和指根离手腕差不多远。
    用比值而不是绝对距离 —— 手离镜头远近都不影响判断。
    ============================================================ */

  /* 两个关键点之间的直线距离（坐标是 0~1 的归一化值，直接用） */
  function dist(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    var dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* 输入 21 个关键点，输出 'open' / 'fist' / 'unknown' */
  function classifyGesture(lm) {
    var wrist = lm[0];
    var tips = [8, 12, 16, 20];  // 食指/中指/无名指/小指 的"指尖"编号
    var mcps = [5, 9, 13, 17];   // 对应的"指根"编号
    var openCount = 0;
    var fistCount = 0;

    for (var i = 0; i < 4; i++) {
      var tipD = dist(lm[tips[i]], wrist);
      var mcpD = dist(lm[mcps[i]], wrist);
      if (mcpD === 0) continue;             // 理论上看不到，防个万一（除以零会出事）
      if (tipD > mcpD * OPEN_RATIO) openCount++;
      if (tipD < mcpD * FIST_RATIO) fistCount++;
    }

    if (openCount >= OPEN_MIN_FINGERS) return 'open'; // 至少 3 根伸直 = 张掌
    if (fistCount >= 4) return 'fist';                // 4 根全蜷缩 = 握拳
    return 'unknown';                                  // 四不像 = 保持现状
  }

  /* ============================================================
    四、手势状态指示灯：预览小窗上方的"仪表盘"
    ------------------------------------------------------------
    元素在这里用 JS 动态创建（样式在 index.html <head> 的 <style> 里），
    四种状态靠 data-state 切换圆点颜色。指示灯只看原始判定、不等防抖，
    这样用户一抬手马上有反馈；蛋糕切换仍走防抖，两边互不干扰。
    ============================================================ */
  var INDICATOR_TEXT = {
    open: '✋ Open palm',   // 绿点：认出张开的手掌
    fist: '✊ Fist',        // 金点：认出握拳
    none: '👀 No hand',     // 灰点：没看见手 / 手势看不清
    off:  '📷 Camera off'   // 红点：摄像头或模型罢工（此时手动按钮会接管）
  };

  function createIndicator() {
    if (indicatorEl) return;
    indicatorEl = document.createElement('div');
    indicatorEl.id = 'gesture-status';
    indicatorEl.className = 'hidden';              // 先藏着，帧循环跑起来再亮相
    indicatorEl.setAttribute('data-state', 'none');
    var dot = document.createElement('span');
    dot.className = 'gs-dot';
    indicatorTextEl = document.createElement('span');
    indicatorTextEl.className = 'gs-text';
    indicatorTextEl.textContent = INDICATOR_TEXT.none;
    indicatorEl.appendChild(dot);
    indicatorEl.appendChild(indicatorTextEl);
    document.body.appendChild(indicatorEl);
    /* 窗口大小变了，预览窗位置会变，指示灯跟着重新贴 */
    window.addEventListener('resize', positionIndicator);
  }

  /* 预览窗的高度随摄像头画面比例变（4:3、16:9 都有可能），
     纯 CSS 没法精确"贴在它正上方"，所以直接量出小窗的实际位置再贴上去：
     右对齐小窗右边缘，底边距小窗顶 8px */
  function positionIndicator() {
    if (!indicatorEl || !video) return;
    var rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // 小窗还没显示，用 CSS 兜底位置
    indicatorEl.style.right = (window.innerWidth - rect.right) + 'px';
    indicatorEl.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  }

  function setIndicator(state) {
    if (!indicatorEl) return;
    if (indicatorEl.getAttribute('data-state') === state) return; // 没变就不碰 DOM，省性能
    indicatorEl.setAttribute('data-state', state);
    indicatorTextEl.textContent = INDICATOR_TEXT[state] || INDICATOR_TEXT.none;
  }

  function showIndicator() {
    if (!indicatorEl) return;
    indicatorEl.classList.remove('hidden');
    positionIndicator();
  }

  /* ============================================================
    五、识别结果回调：每分析完一帧画面就被 Hands 叫一次
    ============================================================ */
  function onResults(results) {
    /* 收到结果 = 链路是通的：撤掉看门狗。
       手动按钮只要是"我们亮出来的"（看门狗超时/连续出错），识别恢复了就收回，
       避免按钮和手势双控制并存让人困惑；hideFallbackIfOurs 内部有标记判断，每帧调用也安全 */
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    hideFallbackIfOurs();
    consecutiveErrors = 0; // 能出结果说明链路是通的，错误计数清零

    var lm = results && results.multiHandLandmarks && results.multiHandLandmarks[0];

    /* 第一次见到手：留个显眼的日志，方便排查"到底认出来没有" */
    if (lm && !firstHandLogged) {
      firstHandLogged = true;
      console.log('[gesture] hand detected');
    }

    var gesture = lm ? classifyGesture(lm) : 'unknown';

    /* 指示灯实时刷新（用防抖前的原始判定）：
       手在但姿势四不像（unknown）也显示 No hand —— 等于提醒用户
       "现在这个姿势不算数，请张开花掌或握拳"，反馈更直观 */
    if (lm && gesture === 'open') setIndicator('open');
    else if (lm && gesture === 'fist') setIndicator('fist');
    else setIndicator('none');

    /* ---------- 防抖核心：少数服从多数，连续 5 帧才算数 ----------
       类比：投票表决，零散一两票不算，连续 5 票才通过。
       中间被打断（手晃了一下变成 unknown）→ 清零重新数 */
    if (gesture === 'unknown') {
      candidate = 'unknown';
      candidateFrames = 0;
      return;
    }
    if (gesture === candidate) {
      candidateFrames++;
    } else {
      candidate = gesture;
      candidateFrames = 1;
    }

    /* 候选还没坐实 / 和当前状态一样 → 不动作 */
    if (candidateFrames < FRAMES_TO_CONFIRM || candidate === currentGesture) return;

    /* 冷静期检查：刚切换完 500ms 内不再切换，防止一次挥手被当成两次 */
    var now = performance.now();
    if (now - lastSwitchAt < COOLDOWN_MS) return;

    /* 通过所有检查：正式切换！ */
    currentGesture = candidate;
    lastSwitchAt = now;
    if (typeof window.toggleCakeExplode === 'function') {
      window.toggleCakeExplode(currentGesture === 'open'); // 张掌=炸开，握拳=恢复
    }
  }

  /* ============================================================
    六、容错：出问题就亮出手动按钮（Plan B）
    ============================================================ */
  function showFallback() {
    var el = document.getElementById('gesture-fallback');
    if (el && el.classList.contains('hidden')) {
      el.classList.remove('hidden');
      fallbackShownByUs = true; // 记一笔：这是我们亮出来的
    }
  }

  function hideFallbackIfOurs() {
    /* 只收回"我们亮出来的"按钮；如果是 form.js 亮的（无摄像头模式），不能动 */
    if (!fallbackShownByUs) return;
    var el = document.getElementById('gesture-fallback');
    if (el) el.classList.add('hidden');
    fallbackShownByUs = false;
  }

  /* 出了大问题的统一动作：指示灯亮红灯（📷 Camera off）+ 亮手动按钮。
     无论哪一步翻车，用户永远有一条能玩的退路 */
  function onFatal(message, err) {
    if (err) console.warn(message, err);
    else console.warn(message);
    showIndicator(); // 帧循环没跑起来时指示灯本来是藏着的，出错必须让它露脸
    setIndicator('off');
    showFallback();
  }

  /* 送帧失败累计太多 = 模型大概率崩了，别硬撑，亮按钮 */
  function onSendError(err) {
    consecutiveErrors++;
    if (consecutiveErrors === 8) {
      onFatal('手势模型连续出错，已切换为手动按钮模式：', err);
    }
  }

  /* ============================================================
    七、手动帧循环：取代旧版 Camera 工具类的"传送带"
    ------------------------------------------------------------
    原理像"人肉传送带"：浏览器每刷新一次画面（requestAnimationFrame），
    我们就看一眼 video，把当前画面递给 Hands 分析。
    两条纪律：
      1. 串行闸门 —— 上一帧没分析完（sending=true），这一帧直接跳过，
         绝不插队，防止请求堆积把模型压垮；
      2. 页面不可见就停工（切后台/锁屏），回来再复工，省电省算力。
    ============================================================ */

  /* 向浏览器预约"下一帧"。rafScheduled 保证同一时刻最多只有一个预约在排队 */
  function scheduleNextTick() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(function () {
      rafScheduled = false;
      tick();
    });
  }

  function tick() {
    if (!loopRunning || document.hidden) return; // 停工中：visibilitychange 负责唤醒
    scheduleNextTick();
    if (sending) return;                         // 闸门关闭：上一帧还在分析，跳过
    if (!video || video.readyState < 2) return;  // 画面没就绪（readyState 2=有当前帧），等下一帧

    sending = true; // 拉下闸门，这帧独占
    var p;
    try {
      p = hands.send({ image: video });
    } catch (e) {
      sending = false;
      onSendError(e);
      return;
    }
    /* send 返回 Promise：分析完（onResults 被叫过）才兑现。
       无论成功失败，都要把闸门抬起来，不然循环就卡死了 */
    if (p && typeof p.then === 'function') {
      p.then(function () {
        sending = false;
      }, function (err) {
        sending = false;
        onSendError(err);
      });
    } else {
      sending = false;
    }
  }

  /* 等 video 真的有画面（readyState >= 2 即 HAVE_CURRENT_DATA）。
     每 100ms 看一眼，最多等 5 秒；等不到说明流本身有问题，走容错 */
  function waitVideoReady(done) {
    var waited = 0;
    var timer = setInterval(function () {
      if (video.readyState >= 2) {
        clearInterval(timer);
        done(true);
        return;
      }
      waited += 100;
      if (waited >= VIDEO_READY_TIMEOUT_MS) {
        clearInterval(timer);
        done(false);
      }
    }, 100);
  }

  /* ============================================================
    八、主入口：window.startGestureRecognition(stream)
    ------------------------------------------------------------
    工作流程像一条流水线：
      form.js 授权的摄像头 → video 元素（画面）→ 手动帧循环（逐帧取）
      → Hands 大脑（分析出 21 个点）→ onResults（指示灯 + 投票防抖）
      → window.toggleCakeExplode（炸开/恢复）
    ============================================================ */
  window.startGestureRecognition = function (stream) {
    if (started) return;
    started = true;

    if (!stream) return; // 没摄像头 = 降级模式，手动按钮由 form.js 负责亮，我们直接休息

    /* ---------- 1. 备好指示灯（先藏着，帧循环跑起来或出错时再亮相） ----------
       放在最前面造好：这样后面任何一步翻车，onFatal 都能把红灯亮出来 */
    createIndicator();

    /* CDN 挂了（断网/被墙）时全局变量不存在：提前检查，别让页面崩掉 */
    if (typeof Hands !== 'function') {
      onFatal('手势识别库没加载成功（可能断网），已切换为手动按钮模式。');
      return;
    }

    /* ---------- 2. 造"大脑"：Hands ---------- */
    try {
      hands = new Hands({
        /* 模型的"零件"（wasm 等文件）从 CDN 按需下载，告诉它去哪儿拿 */
        locateFile: function (file) {
          return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file;
        }
      });
      hands.setOptions({
        maxNumHands: 1,             // 只认一只手：两只手乱挥会打架
        modelComplexity: 0,         // 0=轻快小模型（手机友好），1=更准但慢
        minDetectionConfidence: 0.6,// 多确定"这是只手"才上报（0~1，调高更严格）
        minTrackingConfidence: 0.5  // 跟踪过程中的信心门槛
      });
      hands.onResults(onResults);   // 分析完一帧就喊 onResults
    } catch (e) {
      onFatal('手势模型创建失败，已切换为手动按钮模式：', e);
      return;
    }

    /* ---------- 3. 找到 form.js 已经接好画面的 video ---------- */
    video = document.getElementById('cam-preview');
    if (!video) {
      onFatal('找不到 #cam-preview 视频元素，已切换为手动按钮模式。');
      return;
    }

    /* ---------- 4. 等画面就绪 → 启动帧循环 ----------
       form.js 在用户授权后会把流挂到 video 上并 play，
       但 scene.js 调我们的时刻，浏览器可能还没攒出第一帧，
       所以先轮询等画面，等不到（5 秒）就说明流有问题，走容错 */
    waitVideoReady(function (ok) {
      if (!ok) {
        onFatal('等不到摄像头画面（视频流可能没准备好），已切换为手动按钮模式。');
        return;
      }
      loopRunning = true;
      showIndicator();
      setIndicator('none');
      console.log('[gesture] frame loop started'); // 显眼标记：排查时先看有没有这行
      tick(); // 第一脚油门，之后循环自己往下转
    });

    /* ---------- 5. 看门狗：10 秒内一次识别结果都没有 = 模型可能卡死了 ----------
       比如 wasm 文件下载失败，Hands 不会报错但也不干活，
       这时候悄悄亮出手动按钮，用户不至于干瞪眼 */
    watchdogTimer = setTimeout(function () {
      watchdogTimer = null;
      onFatal('手势模型 10 秒没有响应（可能网络慢），已为你打开手动按钮双保险。');
    }, WATCHDOG_MS);

    /* ---------- 6. 页面切到后台就停工，回前台再复工 ----------
       类比：离开房间随手关灯。切后台时 requestAnimationFrame 本来也会歇，
       这里再上一道保险；回到前台时补一脚"油门"，把停掉的循环唤醒 */
    document.addEventListener('visibilitychange', function () {
      if (!loopRunning || document.hidden) return;
      tick(); // 回到前台：重新踩一脚
    });
  };
})();
