/* ============================================================
 * gesture.js —— MediaPipe 手势识别（张掌炸开 / 握拳恢复）
 * ------------------------------------------------------------
 * 这个文件负责三件事：
 *   1. 启动手势识别：用 CDN 引入的全局 Hands（大脑，负责看懂手）
 *      + 全局 Camera（传送带，负责把摄像头画面一帧帧喂给大脑）
 *   2. 判定手势：只看 21 个关键点的几何关系，不依赖任何模型输出分类：
 *        张开手掌 ✋ → 炸开蛋糕
 *        握拳     ✊ → 恢复原样
 *        其他/看不清 → 保持现状（不乱动）
 *   3. 防抖 + 容错：连续 5 帧都是同一手势才生效（快速乱挥不会鬼畜）；
 *      模型加载失败就亮出手动按钮（Plan B 双保险）
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

  /* 传给识别模型的画面尺寸：越小越快但越不准。320x240 够认手势，手机也不卡 */
  var CAM_WIDTH = 320;
  var CAM_HEIGHT = 240;

  /* ============================================================
    二、内部状态
    ============================================================ */
  var started = false;            // 单例锁：只启动一次
  var hands = null;               // MediaPipe 的"大脑"
  var mpCamera = null;            // MediaPipe 的"传送带"
  var fallbackShownByUs = false;  // 手动按钮是不是我们亮出来的（是的话恢复时要收回去）

  /* 防抖用的计数器 */
  var candidate = 'unknown';      // 正在"候选"的手势（还没坐实）
  var candidateFrames = 0;        // 它已经连续出现几帧了
  var currentGesture = null;      // 当前已生效的手势（'open' / 'fist'）
  var lastSwitchAt = 0;           // 上次切换的时刻（算冷静期用）

  var watchdogTimer = null;       // 看门狗：模型 10 秒没反应就亮手动按钮
  var consecutiveErrors = 0;      // 连续送帧失败次数（防止模型崩了还硬撑）

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
    四、识别结果回调：每分析完一帧画面就被 Hands 叫一次
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
    var gesture = lm ? classifyGesture(lm) : 'unknown';

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
    五、容错：模型加载失败时亮出手动按钮（Plan B）
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

  /* 送帧失败累计太多 = 模型大概率崩了，别硬撑，亮按钮 */
  function onSendError(err) {
    consecutiveErrors++;
    if (consecutiveErrors === 8) {
      console.warn('手势模型连续出错，已切换为手动按钮模式：', err);
      showFallback();
    }
  }

  /* ============================================================
    六、主入口：window.startGestureRecognition(stream)
    ------------------------------------------------------------
    工作流程像一条流水线：
      摄像头 → video 元素（画面）→ Camera 传送带（逐帧取）
      → Hands 大脑（分析出 21 个点）→ onResults（投票防抖）
      → window.toggleCakeExplode（炸开/恢复）
    ============================================================ */
  window.startGestureRecognition = function (stream) {
    if (started) return;
    started = true;

    if (!stream) return; // 没摄像头 = 降级模式，手动按钮由 form.js 负责亮，我们直接休息

    /* CDN 挂了（断网/被墙）时全局变量不存在：提前检查，别让页面崩掉 */
    if (typeof Hands !== 'function' || typeof Camera !== 'function') {
      console.warn('手势识别库没加载成功（可能断网），已切换为手动按钮模式。');
      showFallback();
      return;
    }

    /* ---------- 1. 造"大脑"：Hands ---------- */
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
      console.warn('手势模型创建失败，已切换为手动按钮模式：', e);
      showFallback();
      return;
    }

    /* ---------- 2. 造"传送带"：Camera ----------
       Camera 会把 video 元素里的画面一帧帧送去分析。
       video 元素的摄像头画面在 form.js 里已经接好（用户已授权），
       Camera 内部会复用/重建这条流，我们不用操心 */
    var video = document.getElementById('cam-preview');
    if (!video) {
      console.warn('找不到 #cam-preview 视频元素，已切换为手动按钮模式。');
      showFallback();
      return;
    }

    try {
      mpCamera = new Camera(video, {
        onFrame: function () {
          /* 把这一帧画面送给大脑分析。返回的是 Promise，
             用 .catch 兜住失败，攒够次数就切手动模式 */
          var p = hands.send({ image: video });
          if (p && typeof p.catch === 'function') {
            p.catch(onSendError);
          }
        },
        width: CAM_WIDTH,
        height: CAM_HEIGHT
      });
      var startPromise = mpCamera.start();
      if (startPromise && typeof startPromise.catch === 'function') {
        startPromise.catch(function (e) {
          console.warn('摄像头传送带启动失败，已切换为手动按钮模式：', e);
          showFallback();
        });
      }
    } catch (e) {
      console.warn('摄像头传送带创建失败，已切换为手动按钮模式：', e);
      showFallback();
      return;
    }

    /* ---------- 3. 看门狗：10 秒内一次识别结果都没有 = 模型可能卡死了 ----------
       比如 wasm 文件下载失败，Hands 不会报错但也不干活，
       这时候悄悄亮出手动按钮，用户不至于干瞪眼 */
    watchdogTimer = setTimeout(function () {
      watchdogTimer = null;
      console.warn('手势模型 10 秒没有响应（可能网络慢），已为你打开手动按钮双保险。');
      showFallback();
    }, 10000);

    /* ---------- 4. 页面切到后台就暂停，省电省流量 ----------
       类比：离开房间随手关灯。visibilitychange 是浏览器提供的"出门/回家"通知 */
    document.addEventListener('visibilitychange', function () {
      if (!mpCamera) return;
      if (document.hidden) {
        try { mpCamera.stop(); } catch (e) { /* 停失败也没关系 */ }
      } else {
        try {
          var p = mpCamera.start();
          if (p && typeof p.catch === 'function') p.catch(function () { /* 恢复失败下次再说 */ });
        } catch (e) { /* 同上 */ }
      }
    });
  };
})();
