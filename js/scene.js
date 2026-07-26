/* ============================================================
 * scene.js —— 3D 珍珠球生日蛋糕场景（Three.js r128）
 * ------------------------------------------------------------
 * 这个文件负责五件事：
 *   1. 搭舞台：纯黑背景 + 满天星星（像把房间灯关掉，只留蛋糕上的烛光）
 *   2. 堆蛋糕：四百多颗"亮晶晶"的小球（瓷珠 + 通透玻璃珠，带环境反射高光）
 *      沿 4 层"阶梯式"同心圆环排成镂空壳体蛋糕（直径层层跳变 ≥30%，
 *      像真蛋糕一层摞一层）—— 层内部留空，从层间台阶缝隙能
 *      透出背后的黑背景和星光，像一串串彩色小灯泡勾出蛋糕的剪影；
 *      蛋糕周围还有一小撮慢悠悠漂浮的"氛围散球"，添一份梦幻感
 *   3. 立招牌：蛋糕正上方紧凑叠着一小簇（从下到上）—— 发光岁数数字、
 *      迷你蜡烛+泪滴形火焰（根部钉在烛芯上、中上部随风轻摆）、
 *      寿星名字、金色衬线字 "Happy Birthday"（全都永远面向你）
 *   4. 放照片：照片做成"拍立得"（白边+照片）镶在壳体轮廓的球环之间，
 *      轮廓球会主动给照片让出一块"空洞"，绝不挡住寿星的脸
 *   5. 炸开魔法：window.toggleCakeExplode() —— 小球像漫天泡泡海洋一样
 *      炸满整个画面并缓缓游动，照片直接飞到你眼前放大 3 倍多展示，
 *      球海还会自觉让开"照片与相机之间的走廊"；再触发一次就飞回去
 *
 * 对外只暴露两个函数（form.js 和 gesture.js 会调用，契约不可改）：
 *   - window.startCakeScene({name, age, photos, cameraStream})
 *   - window.toggleCakeExplode(exploded)   exploded=true 炸开 / false 恢复
 * ============================================================ */

(function () {
  'use strict';

  /* ============================================================
    一、可调参数区（想改效果，先改这里，每处都写了"改了会怎样"）
    ============================================================ */

  /* 糖果屋暖色盘：小球大部分从这里取色，整体是"温暖糖果店"的感觉。
     想换风格就改色号，比如改成全粉系：0xff9ff3, 0xfecfef ... 随你发挥 */
  var PEARL_COLORS = [
    0xffb3c1, // 蜜桃粉
    0xff9f68, // 蜜糖橙
    0xffe29a, // 奶油黄
    0xff6b81, // 草莓红
    0xffc8a2, // 暖杏
    0xffd76e, // 淡金
    0xfff3e0  // 奶白
  ];

  /* 冷色只做"点缀"：两颗明亮的马卡龙色，像蛋糕上偶尔撒的糖针。
     它们出现的总概率由 COOL_RATIO 控制（≤20%），多了就会抢走暖色调 */
  var COOL_COLORS = [
    0xa8e6ff, // 浅蓝马卡龙
    0xb5f0d8  // 薄荷马卡龙
  ];
  var COOL_RATIO = 0.18; // 冷色球出现的概率：0.18 = 大约每 6 颗里 1 颗，你可以改成 0.1 更暖

  /* 蛋糕结构：4 层"阶梯式镂空壳体"，像真蛋糕一样一层摞一层 ——
     相邻两层直径差 ≥30%（直径比 ≤0.7），层与层之间有清清楚楚的"台阶"，
     不再是从宽到窄平滑收窄的山坡。
     每层是一个"扁平圆柱台"：底边圈 + 顶边圈（垂直距离 = LAYER_THICK 层厚）
     围出明确的层厚度；相邻层的 y 间距 = 层厚 + LAYER_GAP 台阶缝，
     从缝隙能透出背后的黑背景和星光，断层一眼就能看到。
     radius = 外圈半径；y = 这一层"底边圈"的高度（顶边圈在 y + LAYER_THICK）。
     想让台阶更夸张：把 LAYER_GAP 调大；想每层更厚实：调大 LAYER_THICK */
  var LAYER_THICK = 0.80; // 层厚（顶边圈到底边圈），0.7~0.9 之间最像真蛋糕
  var LAYER_GAP = 1.15;   // 台阶缝隙（上一层底圈到下一层顶圈），1.1~1.3 断层最清楚
  var LAYERS = [
    { radius: 5.2, y: 0.60 }, // 最底层（直径 10.4）
    { radius: 3.6, y: 2.55 }, // = 0.60 + 层厚0.80 + 台阶缝1.15；直径比 3.6/5.2 ≈ 0.69 ≤0.7
    { radius: 2.5, y: 4.50 }, // = 2.55 + 0.80 + 1.15；直径比 2.5/3.6 ≈ 0.69 ≤0.7
    { radius: 1.6, y: 6.45 }  // = 4.50 + 0.80 + 1.15；直径比 1.6/2.5 = 0.64 ≤0.7
  ]; // 壳体约 416 球 + 内馅点缀约 9 颗（半径>2.2 的 3 层 × 3 颗）+ 氛围散球约 85 颗 ≈ 桌面端 510 球
     //（手机端自动×0.45 ≈ 230 球保帧率；有照片时轮廓球让位会再少几十颗）

  /* 轮廓环三兄弟：球沿圆周等距排列，RING_GAP 是相邻球心的目标间距
     （≈ 球径×1.15，既不重叠成串也不露大缺口）；内圈沿半径方向缩进
     RING_INSET 并抬高一点、角度错半格，两圈套起来壳体才有"厚度感" */
  var RING_GAP = 0.55;   // 想轮廓更密实改成 0.48，更稀疏通透改成 0.65
  var RING_INSET = 0.55; // 内外圈的径向错开距离
  var SKIRT_R = 0.24;    // 轮廓球基础半径：大小几乎一致，剪影才整齐（想球更大调到 0.27）

  /* 氛围散球：蛋糕附近空间里慢悠悠漂浮的一小撮球（壳体内部不填满，
     省下的球数匀一部分给它们），炸开成球海时它们也是主力军。
     数量要克制，多了就抢了镂空蛋糕的风头 */
  var AMBIENT_COUNT = 85;

  /* 球的实际半径由 pickBallRadius() 分段随机（0.10~0.44，大大小小像泡泡）。
     这里的 BALL_R_MAX 只用来估算"蛋糕占地多宽 / 顶部多高"（给相机和蜡烛定位），
     务必 ≥ 实际最大半径 0.44，否则相机会算得太近、蜡烛会插进球里 */
  var BALL_R_MAX = 0.44;
  var GLASS_RATIO = 0.25;   // "玻璃珠"占比：0.25 = 大约每 4 个球里有 1 个半透明
  var PEARL_EMISSIVE = 0.42; // 瓷珠自发光：0.35~0.5 之间最像"夜光小彩灯"，再高会过曝成白球、丢了色相
  var GLASS_EMISSIVE = 0.36; // 玻璃珠自发光：0.3~0.45 之间通透又亮堂，像水果硬糖里裹着小灯泡

  var STAR_COUNT = 700;   // 星星数量（手机端减半）。想更梦幻改成 1200 试试
  var CENTER_Y = 3.9;     // 炸开球海的球心高度（蛋糕身体的"心脏"，小球从它往外炸）。
                          // 注意：相机注视点不用它！改用 contentCenterY（见 fitCameraToContent）

  /* 金色标题的站位参数：既用来摆放标题，也用来算"内容包围盒"的顶边，
     两处共用同一组数，改了一处构图自动跟上，不会顾此失彼 */
  var TITLE_DY = 3.20; // 标题悬在蛋糕顶上方的高度。想标题更靠近蛋糕就调小
  var TITLE_H = 1.25;  // 标题牌子的实际高度（算画面总高时要用它的上半边）

  var ORBIT_SECONDS = 25; // 相机绕蛋糕转一圈的秒数（改小→转得更快，会晕哦）
  var EXPLODE_MS = 1000;  // 炸开/恢复动画时长（0.8~1.2 秒之间最舒服）

  var PHOTO_MAX = 10;           // 最多上墙的照片数（太多了会挡蛋糕）
  var PHOTO_CLEAR = 1.3;        // 照片专属的"私人空间"半径：这个范围内的球会让位
  var PHOTO_EXPLODE_SCALE = 3.4; // 炸开后照片放大的基准倍数（3~4 之间最抢眼，寿星必须是大明星）

  /* 炸开后小球的散布范围：以蛋糕中心为球心的大球壳。
     另外还有约 45% 的球会落在更近的"近景带"(8~16)，萦绕在照片簇四周 ——
     但炸开瞬间会把挡在"照片↔相机走廊"里的球统统请出去（见 CORRIDOR_R） */
  var EXPLODE_R_MIN = 13; // 远景带：飞得最近的球离中心多远
  var EXPLODE_R_MAX = 24; // 远景带：飞得最远的球（别超过相机远裁剪面 300，放心）
  var CORRIDOR_R = 3.4;   // "照片走廊"半径：走廊内的球会被推到走廊外，想照片更独占 C 位就调大

  /* ============================================================
    二、内部状态（只初始化一次的"单例"零件）
    ============================================================ */
  var started = false;        // 防止 startCakeScene 被调用两次（单例锁）
  var scene, camera, renderer;
  var billboards = [];        // 所有"每帧要面向相机"的平面（标题/名字/岁数）
  var floatItems = [];        // 所有"会漂浮 + 会炸开"的东西（小球 + 照片）
  var photoItems = [];        // 只装照片（floatItems 的子集，炸开时单独算目标位）
  var photoSlots = [];        // 每张照片的"家"坐标：建球时照着它让位，建照片时照着它落座
  var orbitDist = 14;         // 相机到蛋糕中心的水平距离（fitCameraToContent 会按包围盒重算）
  var camHeight = 4.4;        // 相机高度（同上，会被重算成"注视点 + 距离的10%"）
  var contentCenterY = CENTER_Y; // 相机注视点 = 内容包围盒的正中心（初始化时精算）

  /* 蜡烛火焰相关的零件（每帧摇曳动画要用） */
  var flameGroup = null;      // 火焰整体（蓝根+内焰+中焰+光晕+点光源都挂它身上）
  var flameLight = null;      // 火焰的暖色点光源
  var flameGlow = null;       // 火焰光晕贴片
  var flameBaseY = 0;         // 火焰根部的高度 = 烛芯顶端，火焰组原点永远钉在这里
  var flameFlicker = 0.85;    // 火焰"心情值"：0.7~1.0 之间随机游走，驱动缩放和亮度

  /* 炸开状态机需要的变量 */
  var ready = false;          // 场景是否建好（没建好前 toggle 直接忽略）
  var exploded = false;       // 当前状态：false=蛋糕好好的，true=炸开中/已炸开
  var tweenActive = false;    // 补间动画是否正在进行
  var tweenStart = 0;         // 本次动画的开始时刻（performance.now() 的毫秒数）

  /* 缓动函数 easeOutCubic：动画"先快后慢"，像弹簧快到位时轻轻收住，
     比匀速运动自然得多。数学表达式：1 - (1-t)³ */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* 把 x 限制在 [min, max] 之间（算相机距离时用，防止太远/太近） */
  function clamp(x, min, max) {
    return Math.min(max, Math.max(min, x));
  }

  /* 内容包围盒：从"金色标题顶端"到"蛋糕最底层底边"的完整范围。
     相机构图就靠它 —— 注视点对准它的正中心、距离按它的高和宽算，
     不管桌面横屏还是手机竖屏，蛋糕+招牌整簇都能刚好装进画面，
     上下留白天然相等（不会再"上半屏空着、蛋糕底部被切掉"） */
  function computeContentBounds() {
    var topY = LAYERS[LAYERS.length - 1].y + LAYER_THICK + 0.35 // 顶层封口球顶端
      + TITLE_DY + TITLE_H / 2;                                 // 再叠上标题的上边缘
    var bottomY = LAYERS[0].y - SKIRT_R; // 最底层底圈球的下缘
    return {
      H: topY - bottomY,                 // 内容总高度
      centerY: (topY + bottomY) / 2,     // 内容正中心 = 相机注视点
      halfW: LAYERS[0].radius + BALL_R_MAX + 0.6 // 内容半宽 = 最底层半径 + 球径 + 一点边距
    };
  }

  /* 构图公式（横屏竖屏同一套，resize 时也走这里）：
     ① 注视点 = 内容中心 contentCenterY —— 上下留白自然相等；
     ② 距离取"高度刚好放下"和"宽度刚好放下"两者中较远的那个：
        distV = (H/2) / (tan(fov/2) × 0.72)        → 内容高度占屏 72%，上下各留约 14%
        distW = halfW / (tan(fov/2) × aspect × 0.85) → 内容宽度占屏 85%，左右各留约 7%
        （竖屏手机 aspect 小，distW 会变大 → 自动站远，蛋糕底层绝不顶出屏幕）
     ③ 相机高度 = 注视点 + 距离的 10%，形成轻微俯视，蛋糕层叠的台阶更有立体感。
     想让画面更紧凑：把 0.72 / 0.85 调大；想更松弛、星星更多：调小 */
  function fitCameraToContent() {
    var b = computeContentBounds();
    contentCenterY = b.centerY;
    var halfFovTan = Math.tan((camera.fov / 2) * Math.PI / 180);
    var distV = (b.H / 2) / (halfFovTan * 0.72);
    var distW = b.halfW / (halfFovTan * camera.aspect * 0.85);
    orbitDist = clamp(Math.max(distV, distW) * 1.05, 10, 40); // ×1.05 留 5% 安全边，防球漂移出画
    camHeight = contentCenterY + orbitDist * 0.10;
  }

  /* ============================================================
    三、主入口：window.startCakeScene(opts)
    ============================================================ */
  window.startCakeScene = function (opts) {
    if (started) return;                 // 单例：已经建过场景就直接返回
    started = true;

    opts = opts || {};
    var name = String(opts.name || 'Friend');
    var age = String(opts.age || '');
    var photos = Array.isArray(opts.photos) ? opts.photos : [];

    if (typeof THREE === 'undefined') {  // CDN 挂了也不能让页面崩掉
      console.warn('Three.js 没加载成功（可能断网了），3D 场景无法启动。');
      return;
    }

    var container = document.getElementById('scene-container');
    if (!container) return;

    /* 手机端性能保护：屏幕窄 = 大概率是手机；CPU 核心少 = 低性能设备。
     这两种情况小球和星星都减量，就像小厨房少开几个灶，照样能做菜还不卡 */
    var lowPower = window.innerWidth < 600 ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
    var ballScaleFactor = lowPower ? 0.45 : 1;
    var starCount = lowPower ? Math.floor(STAR_COUNT / 2) : STAR_COUNT;
    var isMobile = window.innerWidth < 600;

    /* ---------- 1. 场景 + 相机 + 渲染器 ---------- */
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // 纯黑背景：才能衬出球球的珠光

    /* 视野角(fov)：手机竖屏更窄，稍微开大一点(62°)才能装下整个蛋糕 */
    var fov = isMobile ? 62 : 55;
    camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 300);

    /* 构图居中（修复"上半屏大片空白、蛋糕底部溢出被切"）：
     不再拍脑袋盯固定高度，而是先算"内容包围盒"（标题顶 → 蛋糕底），
     注视点对准包围盒正中心，距离按 fov 和屏幕比例精算 ——
     上下留白大致相等，整个内容永远完整在画面里（公式见 fitCameraToContent） */
    fitCameraToContent();

    renderer = new THREE.WebGLRenderer({ antialias: !isMobile }); // 手机关抗锯齿省电
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // 高分屏最多 2 倍，再高性能浪费
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    /* ---------- 2. 灯光 ----------
     环境光 = 房间的"基础亮度"，让所有东西不至于死黑；
     两盏暖色点光 = 派对上的金色/玫瑰色射灯，打出温暖珠光感。
     （火焰那里还有一盏专属的、只照亮附近的小暖灯，后面单独建） */
    scene.add(new THREE.AmbientLight(0x999999, 0.7));
    var warmLight = new THREE.PointLight(0xffd9a0, 0.9, 80);
    warmLight.position.set(9, 11, 8);
    scene.add(warmLight);
    var roseLight = new THREE.PointLight(0xff9db0, 0.7, 80);
    roseLight.position.set(-9, 6, -8);
    scene.add(roseLight);

    /* ---------- 3. 星空 ---------- */
    buildStarfield(starCount);

    /* ---------- 4. 珍珠球蛋糕 ----------
       关键顺序：先算好每张照片的"家"（photoSlots），再堆球 ——
       球球们落座前都会看看"这里是不是照片的地盘"，是就换个位置，
       这样照片镶进球丘时自带一圈"空洞"，永远不会被球挡住脸。
       没照片时 photoSlots 是空的，所有位置照常摆球，蛋糕饱满 */
    var photoList = photos.slice(0, PHOTO_MAX);
    computePhotoSlots(photoList.length);
    buildBallCake(ballScaleFactor, !isMobile);

    /* ---------- 5. 照片拍立得（没照片就跳过） ---------- */
    if (photoList.length > 0) {
      buildPhotos(photoList);
    }

    /* ---------- 6. 招牌区：岁数数字 → 蜡烛火焰 → 名字 → 标题 ----------
       紧凑的一小簇叠在蛋糕正上方（金色名牌在最上方），全部加入
       billboards 每帧面向相机。各元素间隙保持 0.12~0.17，匀称不挤不散；
       想整簇更紧凑，把下面几个 +数字 等比例减小即可 */
    var cakeTopY = LAYERS[LAYERS.length - 1].y + LAYER_THICK + 0.35; // 顶层封口球顶端（顶边圈 + 樱桃球）

    if (age !== '') {
      var agePlate = buildAgePlate(age);
      agePlate.position.set(0, cakeTopY + 0.45, 0); // 岁数紧贴蛋糕顶，不悬空
      scene.add(agePlate);
      billboards.push(agePlate);
    }

    buildCandle(cakeTopY + 0.90); // 迷你蜡烛站在岁数数字正上方（蛋糕才是主角）

    var namePlate = buildTextPlate({
      text: name,
      fontStack: '"Playfair Display", Didot, "Bodoni MT", Georgia, "Microsoft YaHei", serif',
      fontSize: 96,
      fillStyle: '#ffefd0',   // 浅金近白：比标题低调，不抢戏
      glowColor: '#d4af37',
      glowBlur: 26,
      planeW: 3.5,            // 比上一代再缩小约 35%，甘当配角
      planeH: 0.8
    });
    namePlate.position.set(0, cakeTopY + 2.05, 0); // 火苗尖与名字之间留了呼吸缝
    scene.add(namePlate);
    billboards.push(namePlate);

    var titlePlate = buildTextPlate({
      text: 'Happy Birthday',
      fontStack: '"Playfair Display", Didot, "Bodoni MT", Georgia, serif',
      fontSize: 148,
      fillStyle: '#d4af37',   // 经典金色：像烫金贺卡
      glowColor: '#ffd700',
      glowBlur: 34,           // 想金色光晕更大就调大它
      planeW: 5.4,            // 比上一代再缩小约 35%，悬在整簇最上方
      planeH: TITLE_H         // 与构图包围盒共用同一个高度常量
    });
    titlePlate.position.set(0, cakeTopY + TITLE_DY, 0);
    scene.add(titlePlate);
    billboards.push(titlePlate);

    /* ---------- 7. 预计算所有小球的"炸开落点" ----------
     先算一份存着，炸开那一刻还会按当时的相机位置重算并"清走廊"，
     几百个随机数对电脑来说眨眼就算完，放心 */
    precomputeBallExplodeTargets();

    /* ---------- 8. 窗口缩放自适应（手机转横屏也要正常显示） ---------- */
    window.addEventListener('resize', onResize);

    ready = true;
    animate(); // 启动渲染循环（相当于按下放映机的开关）

    /* ---------- 9. 联动模块：音乐 + 手势（防御式调用，对方不在也不报错） ---------- */
    if (window.MusicPlayer && typeof window.MusicPlayer.autoplay === 'function') {
      try { window.MusicPlayer.autoplay(); } catch (e) { /* 音乐起不来不影响看蛋糕 */ }
    }
    if (opts.cameraStream) {
      window.__cameraStream = opts.cameraStream; // 存起来，gesture.js 要用
      if (typeof window.startGestureRecognition === 'function') {
        try {
          window.startGestureRecognition(window.__cameraStream);
        } catch (e) {
          console.warn('手势识别启动失败（可以改用页面上的按钮）：', e);
        }
      }
    }
  };

  /* ============================================================
    四、搭舞台零件
    ============================================================ */

  /* 星空：一大堆白色小点随机撒在一个很远的"空心球壳"上。
     用 THREE.Points 而不是一堆小球体 —— 700 个点只算 1 次绘制，极其省性能 */
  function buildStarfield(count) {
    var positions = new Float32Array(count * 3); // 每颗星 3 个坐标 (x,y,z)
    for (var i = 0; i < count; i++) {
      /* 球面均匀随机取点公式（半径 55~100 的球壳，保证星星都在蛋糕外面） */
      var r = 55 + Math.random() * 45;
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.7,              // 想星星更明显就改大，比如 1.2
      sizeAttenuation: true,  // 远的星星自动变小，才有"深空"的感觉
      transparent: true,
      opacity: 0.85,
      depthWrite: false
    });
    scene.add(new THREE.Points(geo, mat));
  }

  /* 程序化环境贴图：用 canvas 画一张"假房间全景"（上亮下暗 + 几团亮斑
     模拟窗户/射灯）。球面会反射这张图，立刻获得真实的高光亮点 ——
     就像玻璃珠能照出房间的样子。只生成一次，所有球共用，几乎零成本 */
  function makeEnvTexture() {
    var canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    var ctx = canvas.getContext('2d');

    /* 竖向渐变：天花板暖白 → 中间紫灰 → 地面近黑 */
    var grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#fff2cf');
    grad.addColorStop(0.5, '#6a5a7a');
    grad.addColorStop(1, '#0c0c14');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 256);

    /* 亮斑 = 假的光源（窗户、射灯），球面反射它们就有"高光点"。
       想高光更多：照着这个格式 [x, y, 半径, 颜色] 多画几团 */
    var blobs = [
      [90, 60, 50, 'rgba(255, 236, 190, 0.95)'],
      [230, 42, 34, 'rgba(255, 255, 255, 0.9)'],
      [360, 74, 56, 'rgba(255, 205, 150, 0.9)'],
      [465, 46, 30, 'rgba(190, 215, 255, 0.85)']
    ];
    blobs.forEach(function (b) {
      var g = ctx.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
      g.addColorStop(0, b[3]);
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b[0], b[1], b[2], 0, Math.PI * 2);
      ctx.fill();
    });

    var tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping; // 告诉 three"这是一张全景反射图"
    return tex;
  }

  /* 照片"私人空间"：先按最终摆放公式算出每张照片的圆心坐标存进 photoSlots。
     建球和建照片都用这同一份坐标，保证"让位的空洞"和照片严丝合缝 */
  function computePhotoSlots(n) {
    photoSlots = [];
    for (var i = 0; i < n; i++) {
      var layerDef = LAYERS[i % 3]; // 轮流嵌在最下面三层的外轮廓上（底层最宽，照片最显眼；0/5/10 张都匀称）
      var angle = (i / n) * Math.PI * 2 + Math.PI / n; // 均匀环绕
      photoSlots.push({
        x: Math.cos(angle) * layerDef.radius,
        y: layerDef.y + LAYER_THICK * 0.5, // 骑在"层厚的正中间"：底圈和顶圈都会让位，照片正好镶进台阶侧面的花边里
        z: Math.sin(angle) * layerDef.radius
      });
    }
  }

  /* 这个坐标离某张照片太近吗？近 = 在照片的"私人空间"里，球不能坐这里 */
  function nearPhotoSlot(x, y, z) {
    for (var i = 0; i < photoSlots.length; i++) {
      var s = photoSlots[i];
      var dx = x - s.x, dy = y - s.y, dz = z - s.z;
      if (dx * dx + dy * dy + dz * dz < PHOTO_CLEAR * PHOTO_CLEAR) return true;
    }
    return false;
  }

  /* 镂空壳体蛋糕：几百颗球沿 4 层阶梯式同心圆环排列勾勒轮廓，层内部留空。
     allowHalo = 是否允许给球加光晕贴片（手机端不加，省性能） */
  function buildBallCake(scaleFactor, allowHalo) {
    /* 几何体和材质尽量"共用"：400 多个球共用 1 个球体模型 + 十几种材质，
     就像用同一个模具烤一炉饼干，省内存、渲染快。
     注意：模型半径做成 1，每个球用自己的缩放当半径，灵活又省钱 */
    var ballGeo = new THREE.SphereGeometry(1, 18, 14);

    /* 环境贴图只生成一次。注意：r128 里 Phong 材质只认"材质自己身上的 envMap"
       （scene.environment 对 Phong 不生效），所以逐个材质挂上；
       scene.environment 顺手设一份兜底，没有 Phong 之外的光照材质也无害 */
    var envMap = makeEnvTexture();
    scene.environment = envMap;

    /* 两套材质（共用同一张环境贴图）×（7 暖色 + 2 马卡龙冷色）：
       ① 瓷珠/珍珠款(约75%)：不透明 + 锐利白色高光(shininess 高 = 光斑小而亮)，
          自发光 0.42 —— 像通了电的彩色小灯泡，但色相还在、不会过曝成白球
       ② 玻璃珠款(约25%)：半透明(0.65~0.80) + depthWrite 关闭（防止透明球
          互相排序错乱、出现奇怪的硬边）+ envMapIntensity 拉高，通透得像水果硬糖 */
    var ALL_COLORS = PEARL_COLORS.concat(COOL_COLORS);
    var pearlMats = ALL_COLORS.map(function (c) {
      return new THREE.MeshPhongMaterial({
        color: c,
        emissive: c,
        emissiveIntensity: PEARL_EMISSIVE,
        shininess: 100,               // 想高光更锐利保持 100，更哑光降到 60
        specular: 0xffffff,           // 纯白色高光，才有"玻璃反光"感
        envMap: envMap,
        envMapIntensity: 1.15         // 想反射更强调到 1.3，更弱降到 0.9
      });
    });
    var glassMats = ALL_COLORS.map(function (c) {
      return new THREE.MeshPhongMaterial({
        color: c,
        emissive: c,
        emissiveIntensity: GLASS_EMISSIVE,
        shininess: 100,
        specular: 0xffffff,
        transparent: true,
        opacity: 0.65 + Math.random() * 0.15, // 0.65~0.80，每颗略不同更自然（更亮更透）
        depthWrite: false,
        envMap: envMap,
        envMapIntensity: 1.45         // 玻璃反射更亮，才有"亮晶晶"的剔透感
      });
    });

    /* 抽材质两步走：先按 COOL_RATIO 决定"暖色还是冷色点缀"，
       再从对应色盘里抽一颗、按 GLASS_RATIO 决定瓷珠还是玻璃珠 */
    function pickMat() {
      var idx;
      if (Math.random() < COOL_RATIO) {
        idx = PEARL_COLORS.length + Math.floor(Math.random() * COOL_COLORS.length);
      } else {
        idx = Math.floor(Math.random() * PEARL_COLORS.length);
      }
      return Math.random() < GLASS_RATIO ? glassMats[idx] : pearlMats[idx];
    }

    /* 球的光晕贴图：复用火焰那张"径向渐变发光圆"的思路，全场只画一张、
       所有光晕共用。约 12% 的球会挂上它，像小灯泡外那圈柔光（bloom 感），
       数量刻意克制 —— 多了会糊成一片白，反而丢了每颗球的颜色 */
    var haloTex = makeGlowTexture();

    /* 生一颗球并给它建"漂浮档案"（轮廓球、内馅球、散球共用这套流程）。
       driftAmpMax = 漂移振幅上限：轮廓球小一点（剪影才清晰），散球大一点（飘得浪） */
    function spawnBall(x, y, z, ballR, driftAmpMax) {
      var mat = pickMat();
      var ball = new THREE.Mesh(ballGeo, mat);
      ball.scale.setScalar(ballR);
      ball.position.set(x, y, z);
      scene.add(ball);

      /* 光晕贴片：挂成球的"孩子"，自动跟着球走、跟着球缩放。
         3.2 ≈ 光晕直径是球径的 1.6 倍，正好探出球面一圈；染上球的本色，
         叠加式发光（AdditiveBlending）让黑色部分完全消失，只留一圈彩色柔光 */
      if (allowHalo && Math.random() < 0.12) {
        var halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: haloTex,
          color: mat.color, // 关键：光晕染上球的本色，才不会一片白光
          transparent: true,
          opacity: 0.25 + Math.random() * 0.15, // 0.25~0.40，想更亮调到 0.5 试试
          blending: THREE.AdditiveBlending,
          depthWrite: false
        }));
        halo.scale.set(3.2, 3.2, 1);
        ball.add(halo);
      }

      var item = makeFloatItem(ball, false);
      item.baseScale = ballR; // 小球的"原始缩放"就是它的半径，动画缩放要乘在它上面
      item.bobAmp = 0.025 + Math.random() * 0.03; // 球的呼吸极轻微，像水母轻轻一张一合

      /* 梦幻漂移参数：随机方向的单位向量 + 独立振幅/频率/相位。
         每帧位置 = 补间位置 + driftDir × sin(时间×频率 + 相位) × 振幅，
         蛋糕形态和炸开形态都生效 —— 球海就像泡泡一样缓缓游动 */
      item.driftDir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (item.driftDir.lengthSq() < 0.0001) item.driftDir.set(0, 1, 0); // 防倒霉的零向量
      item.driftDir.normalize();
      item.driftAmp = 0.05 + Math.random() * (driftAmpMax || 0.15); // 轮廓球 0.05~0.17，散球可到 0.65
      item.driftFreq = 0.2 + Math.random() * 0.4;   // 频率 0.2~0.6 rad/s，慢慢游才梦幻
      item.driftPhase = Math.random() * Math.PI * 2;

      floatItems.push(item);
    }

    /* 沿圆周均匀摆一圈球：angOffset 让内外两圈角度错半格，像砖缝错开才自然。
       轮廓球大小几乎一致（SKIRT_R ± 0.02）、抖动极小，剪影才整齐 */
    function spawnRing(radius, y, count, angOffset) {
      for (var i = 0; i < count; i++) {
        var ang = (i / count) * Math.PI * 2 + angOffset; // 等分圆周，整齐才有"灯串感"
        var x = Math.cos(ang) * radius;
        var z = Math.sin(ang) * radius;
        var py = y + (Math.random() - 0.5) * 0.04;
        if (nearPhotoSlot(x, py, z)) continue; // 轮廓球遇照片让位：灯串被"咬"出一道口子，照片正好镶进去
        spawnBall(x, py, z, SKIRT_R + (Math.random() - 0.5) * 0.04, 0.12);
      }
    }

    for (var layer = 0; layer < LAYERS.length; layer++) {
      var def = LAYERS[layer];
      var topEdgeY = def.y + LAYER_THICK; // 这一层"顶边圈"的高度

      /* ---- 底边外圈 + 顶边外圈：同一半径、垂直相距一个层厚，
         两圈一上一下围出"扁平圆柱台"的侧壁剪影（真蛋糕的层侧面）。
         两圈角度错半格，像砖缝错开，侧面看起来更密实整齐 ---- */
      var outerCount = Math.max(8, Math.round((2 * Math.PI * def.radius / RING_GAP) * scaleFactor));
      spawnRing(def.radius, def.y, outerCount, 0);
      spawnRing(def.radius, topEdgeY, outerCount, Math.PI / outerCount);

      /* ---- 顶边内圈：沿半径缩进 RING_INSET + 再抬高 0.18 + 角度错半格，
         像这一层的"上表面花边"，壳体立刻有了厚度感；
         层内部照旧留空，光从层间台阶缝隙里透过去 ---- */
      var innerR = def.radius - RING_INSET;
      var innerCount = Math.max(8, Math.round((2 * Math.PI * innerR / RING_GAP) * scaleFactor));
      spawnRing(innerR, topEdgeY + 0.18, innerCount, Math.PI / innerCount);

      /* ---- 顶层封口：小环正中心补一颗球，像蛋糕尖上的樱桃 ---- */
      if (layer === LAYERS.length - 1) {
        spawnBall(0, topEdgeY + 0.12, 0, SKIRT_R, 0.08);
      }

      /* ---- 可选的"悬浮内馅"：层内极稀疏点缀几颗（总量 ≤10%），
         透过轮廓缝隙隐约可见，通透里多一层深度。想完全镂空就把 3 改成 0 ---- */
      if (def.radius > 2.2) {
        for (var f = 0; f < 3; f++) {
          var fa = Math.random() * Math.PI * 2;
          var fr = Math.random() * def.radius * 0.5;
          var fx = Math.cos(fa) * fr, fz = Math.sin(fa) * fr;
          var fy = def.y + LAYER_THICK * 0.5 + (Math.random() - 0.5) * 0.2; // 飘在层厚正中
          if (nearPhotoSlot(fx, fy, fz)) continue; // 同样不挡寿星的脸
          spawnBall(fx, fy, fz, pickBallRadius(), 0.2);
        }
      }
    }

    /* ---- 氛围散球：蛋糕周围的空间里慢悠悠漂浮的一小撮，
       像派对上飘着的泡泡，炸开时也是球海的主力军 ---- */
    var ambientN = Math.max(20, Math.round(AMBIENT_COUNT * scaleFactor));
    for (var a = 0; a < ambientN; a++) {
      var aAng = Math.random() * Math.PI * 2;
      var aR = LAYERS[0].radius + 1.3 + Math.random() * 4.5; // 离蛋糕 1.3~5.8 远的一圈空间
      var ax = Math.cos(aAng) * aR, az = Math.sin(aAng) * aR;
      var ay = -0.5 + Math.random() * (LAYERS[LAYERS.length - 1].y + LAYER_THICK + 0.8); // 从蛋糕底一直飘到顶层花边旁
      if (nearPhotoSlot(ax, ay, az)) continue;
      spawnBall(ax, ay, az, pickBallRadius(), 0.6); // 散球漂得更"浪"一点
    }
  }

  /* 分段随机半径：58% 小珠(0.10~0.20) + 32% 中珠(0.20~0.32) + 10% 大珠(0.32~0.44)，
     大大小小错落开，才像随手撒向空中的一把泡泡，而不是同一模具的弹珠。
     （整体比上一代略大一号：球更饱满，球间缝隙自然变小） */
  function pickBallRadius() {
    var r = Math.random();
    if (r < 0.58) return 0.10 + Math.random() * 0.10;
    if (r < 0.90) return 0.20 + Math.random() * 0.12;
    return 0.32 + Math.random() * 0.12;
  }

  /* 照片拍立得：白边底板 + 照片贴面（前置 0.01 防止两个平面"打架闪屏"） */
  function buildPhotos(photos) {
    var frameGeo = new THREE.PlaneGeometry(1.15, 1.4);  // 白边底板（比照片大一圈 = 拍立得的白边）
    var photoGeo = new THREE.PlaneGeometry(0.95, 0.95); // 照片本体
    var frameMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    var loader = new THREE.TextureLoader();

    photos.forEach(function (src, i) {
      var group = new THREE.Group();

      var frame = new THREE.Mesh(frameGeo, frameMat);
      group.add(frame);

      /* 照片材质先给深灰色"占位"，图片加载完成后立刻换上真图。
       为什么不等加载完再建？因为加载是异步的，先占位保证布局整齐 */
      var photoMat = new THREE.MeshBasicMaterial({ color: 0x222233, side: THREE.DoubleSide });
      loader.load(
        src,
        function (tex) { photoMat.map = tex; photoMat.color.set(0xffffff); photoMat.needsUpdate = true; },
        undefined,
        function () { console.warn('有张照片没加载出来（已用纯色代替）：', src); }
      );
      var photo = new THREE.Mesh(photoGeo, photoMat);
      photo.position.set(0, 0.1, 0.01); // 稍微上移：下面留宽一点的白边，更像拍立得
      group.add(photo);

      /* 落座到 photoSlots 提前分好的"家"：均匀环绕 + 高度错开三层，
         球球们早已在这里让出了空洞，照片正好镶进花边里 */
      var slot = photoSlots[i];
      group.position.set(slot.x, slot.y, slot.z);
      scene.add(group);

      var item = makeFloatItem(group, true);
      floatItems.push(item);
      photoItems.push(item);
    });
  }

  /* 文字招牌通用工厂：离屏 canvas 当"画板"写好字，再贴到平面上悬浮起来。
     标题和寿星名字都靠它，只是字号颜色不同 —— 同一个模具，烤两种饼干 */
  function buildTextPlate(opts) {
    var canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 300;
    var ctx = canvas.getContext('2d');

    /* 字太长就自动缩小字号：从目标字号开始量，塞不进 1280px 就减 8 再量 */
    var fontSize = opts.fontSize;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    do {
      ctx.font = 'bold ' + fontSize + 'px ' + opts.fontStack;
      if (ctx.measureText(opts.text).width <= 1280) break;
      fontSize -= 8;
    } while (fontSize > 30);

    /* 发光秘诀：shadowBlur 就是"光晕半径"，同一行字画两遍光更浓 */
    ctx.shadowColor = opts.glowColor;
    ctx.shadowBlur = opts.glowBlur;
    ctx.fillStyle = opts.fillStyle;
    ctx.fillText(opts.text, 700, 155);
    ctx.fillText(opts.text, 700, 155); // 第二遍：光晕叠加更亮

    var tex = new THREE.CanvasTexture(canvas);
    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,   // 透明底：只显示字，不显示 canvas 的黑背景
      side: THREE.DoubleSide,
      depthWrite: false
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(opts.planeW, opts.planeH), mat);
  }

  /* 岁数数字：发光白色小数字，贴在蛋糕尖上方（再缩小后的尺寸，甘当配角） */
  function buildAgePlate(age) {
    var canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    var ctx = canvas.getContext('2d');

    var fontSize = 230;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    do {
      ctx.font = 'bold ' + fontSize + 'px Georgia, "Times New Roman", serif';
      if (ctx.measureText(age).width <= 460) break;
      fontSize -= 10;
    } while (fontSize > 40);

    ctx.shadowColor = '#ffffff'; // 白色光晕：像数字自己在发光
    ctx.shadowBlur = 42;         // 想光更亮就调大它
    ctx.fillStyle = '#ffffff';
    ctx.fillText(age, 256, 165);
    ctx.fillText(age, 256, 165);

    var tex = new THREE.CanvasTexture(canvas);
    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.65), mat); // 比上一代再缩小约 40%
  }

  /* 蜡烛 + 火焰：岁数数字正上方的那一点暖光。
     在上一代 0.6 倍的基础上再缩小约 40% —— 迷你小蜡烛，蛋糕才是主角 */
  function buildCandle(baseY) {
    var CANDLE_H = 0.38; // 蜡烛杆高度。想再小点改成 0.3 试试

    /* 蜡烛杆：细细的粉白圆柱 */
    var candleGeo = new THREE.CylinderGeometry(0.045, 0.055, CANDLE_H, 16);
    var candleMat = new THREE.MeshPhongMaterial({
      color: 0xfff0f3,   // 粉白色，想纯白改成 0xffffff
      shininess: 50,
      specular: 0x888888
    });
    var candle = new THREE.Mesh(candleGeo, candleMat);
    /* 注意：圆柱的 position 是它的"正中心"而不是顶端！
       高 CANDLE_H 的蜡烛放在 baseY + CANDLE_H/2，顶端才正好落在 baseY + CANDLE_H */
    candle.position.set(0, baseY + CANDLE_H / 2, 0);
    scene.add(candle);

    /* 烛芯：顶部一小截黑色细圆柱（高 0.06，中心在 baseY+CANDLE_H+0.03
       → 顶端 = baseY + CANDLE_H + 0.06） */
    var wickGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.06, 6);
    var wickMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    var wick = new THREE.Mesh(wickGeo, wickMat);
    wick.position.set(0, baseY + CANDLE_H + 0.03, 0);
    scene.add(wick);

    /* ============ 火焰：泪滴形三层结构 + 光晕 + 小暖灯 ============
       关键设计（修复"火焰不居中、往屏幕里偏"）：
       flameGroup 的原点精确钉在"烛芯顶端"(x=0, z=0 永不改写)，
       摇曳只做"绕根部的微小倾斜"，根部像钉死在烛芯上，只有中上部摆动 ——
       这样相机环绕到任何角度，火焰都精确立在烛芯正上方 */
    flameBaseY = baseY + CANDLE_H + 0.06; // 精确 = 烛芯顶端的世界高度（跟随 CANDLE_H 和烛芯高）
    flameGroup = new THREE.Group();
    flameGroup.position.set(0, flameBaseY, 0);

    /* ① 根部淡蓝紫小球：真实蜡烛火焰最底部是一圈蓝色（那里燃烧最充分），
       压扁贴在烛芯口，火苗立刻"专业"起来 */
    var baseGeo = new THREE.SphereGeometry(0.02, 10, 8);
    var baseMat = new THREE.MeshBasicMaterial({
      color: 0x7f9dff,   // 淡蓝紫，想更蓝改 0x5f7fff
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    var blueBase = new THREE.Mesh(baseGeo, baseMat);
    blueBase.scale.set(1, 0.7, 1);
    blueBase.position.y = 0.008;
    flameGroup.add(blueBase);

    /* ② 内焰：亮白-淡黄小泪滴（球体沿 y 拉长 2 倍就是泪滴形），
       底部贴在根部（position.y ≈ 半个高度） */
    var innerGeo = new THREE.SphereGeometry(0.021, 12, 10);
    var innerMat = new THREE.MeshBasicMaterial({ color: 0xfff7cc }); // 亮白偏暖
    var inner = new THREE.Mesh(innerGeo, innerMat);
    inner.scale.set(0.9, 2.0, 0.9); // 想火苗更细长就把中间的 2.0 调大
    inner.position.y = 0.045;
    flameGroup.add(inner);

    /* ③ 中焰：橙黄-橙红稍大的半透明泪滴套在外面。
       AdditiveBlending = 和后面的颜色"叠着发光"，亮处更亮，黑边自动消失 */
    var outerGeo = new THREE.SphereGeometry(0.038, 12, 10);
    var outerMat = new THREE.MeshBasicMaterial({
      color: 0xff8a3d,      // 橙黄偏红，想更红改 0xff6a2a
      transparent: true,
      opacity: 0.7,         // 想更透亮降到 0.6，更浓升到 0.8
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    var outer = new THREE.Mesh(outerGeo, outerMat);
    outer.scale.set(1, 2.1, 1);
    outer.position.y = 0.07; // 底部略低于内焰底部，刚好包住蓝色根部
    flameGroup.add(outer);

    /* ④ 光晕贴片：canvas 上画一个径向渐变（中心暖黄 → 向外透明）。
       Sprite 永远正对镜头，且 center 默认 (0.5,0.5) = 贴片正中心对齐 position，
       我们把 position 放在泪滴的视觉中心(y≈0.09)，光晕就正好抱住整团火苗，
       不会出现"光斑飘在火焰上方"的错位感 */
    var glowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending, // 叠加发光：亮处更亮，黑色部分完全消失
      depthWrite: false
    });
    flameGlow = new THREE.Sprite(glowMat);
    flameGlow.scale.set(0.58, 0.68, 1); // 想光晕更大就调大这两个数
    flameGlow.position.y = 0.09;
    flameGroup.add(flameGlow);

    /* ⑤ 火焰专属小暖灯：放在火焰中心，暖橙色。
       distance=4 表示光照到 4 格远就衰减没了，只照亮蜡烛附近的球球 */
    flameLight = new THREE.PointLight(0xffa050, 0.6, 4, 2);
    flameLight.position.y = 0.085;
    flameGroup.add(flameLight);

    scene.add(flameGroup);
  }

  /* 画一张"径向渐变发光圆"贴图：中心暖黄亮白 → 橙黄 → 完全透明 */
  function makeGlowTexture() {
    var canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    var ctx = canvas.getContext('2d');
    var grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255, 240, 200, 1)');
    grad.addColorStop(0.35, 'rgba(255, 180, 80, 0.55)');
    grad.addColorStop(1, 'rgba(255, 140, 40, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
  }

  /* ============================================================
    五、"会漂浮会炸开"的东西的统一档案
    ------------------------------------------------------------
    每个小球/照片都建一份档案，记录：
      home    = 原来的位置（恢复时要飞回来）
      explode = 炸开后的落点（初始化时预计算 / 触发时按相机算）
      cur     = 现在插值到哪了（动画的核心数据）
    每帧渲染时：位置 = cur + 漂移偏移 + 正弦呼吸偏移，动画和漂浮互不干扰
    ============================================================ */
  function makeFloatItem(group, isPhoto) {
    return {
      group: group,
      isPhoto: isPhoto,
      home: group.position.clone(),
      explode: group.position.clone(), // 先占位，稍后填真实目标
      cur: group.position.clone(),
      from: group.position.clone(),    // 动画起点（每次触发时 = 当前位置，保证随时打断都平滑）
      to: group.position.clone(),      // 动画终点
      baseScale: 1,                    // 原始缩放（小球=它的半径，照片=1）
      curScale: 1, scaleFrom: 1, scaleTo: 1, explodeScale: 1,
      curRotX: 0, curRotZ: 0,
      rotFrom: { x: 0, z: 0 }, rotTo: { x: 0, z: 0 },
      rotExplode: { x: 0, z: 0 },
      /* 漂移参数（小球专用，建球时随机化；照片 driftAmp 保持 0 = 不漂移，只呼吸） */
      driftDir: new THREE.Vector3(0, 0, 0), // 漂移方向的单位向量
      driftAmp: 0,                          // 漂移振幅：0=不漂
      driftFreq: 0.4,                       // 漂移频率（rad/s）
      driftPhase: 0,                        // 漂移相位
      /* 呼吸参数：相位错开，小球们才不会"集体做广播体操" */
      phase: Math.random() * Math.PI * 2,
      bobAmp: 0.08 + Math.random() * 0.05,  // 漂浮幅度（照片用；小球建好后会覆盖成更小值）
      bobSpeed: 0.8 + Math.random() * 0.6,  // 漂浮速度
      tiltZ: (Math.random() - 0.5) * 0.3    // 照片专用：一点点歪，像随手贴的拍立得
    };
  }

  /* 小球炸开落点：以蛋糕中心为球心撒满大球壳，分两条带 ——
     约 45% 落在"近景带"(8~16)：正好萦绕在炸开后飞到相机前的照片簇四周，
       照片被漫天泡泡簇拥着，中央区域不会空荡；
     其余落在"远景带"(13~24)：把屏幕的前后左右都填满，才是"球海"而不是"球雾"。
     初始化时算一份，每次炸开还会重算一遍（每次都换个新花样） */
  function precomputeBallExplodeTargets() {
    var center = new THREE.Vector3(0, CENTER_Y, 0);
    floatItems.forEach(function (item) {
      if (item.isPhoto) return; // 照片的落点要在炸开那一刻按相机位置算
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1); // 球面均匀分布的老朋友
      var dist = Math.random() < 0.45
        ? 8 + Math.random() * 8    // 近景带：萦绕照片簇的泡泡（想更密就把 0.45 调大）
        : EXPLODE_R_MIN + Math.random() * (EXPLODE_R_MAX - EXPLODE_R_MIN);
      item.explode.set(
        center.x + dist * Math.sin(phi) * Math.cos(theta),
        center.y + dist * Math.cos(phi),
        center.z + dist * Math.sin(phi) * Math.sin(theta)
      );
      item.rotExplode.x = (Math.random() - 0.5) * 2.4; // 飞出去时带随机翻滚
      item.rotExplode.z = (Math.random() - 0.5) * 2.4;
    });
  }

  /* 照片炸开落点：飞到"离相机很近的正前方"，松松垮垮聚成一簇 ——
     炸开这一刻寿星就是大明星，照片必须怼到镜头前放大展示！
     故意不排整齐 —— 横七竖八才像撒在空中的一叠拍立得。
     为什么不在初始化时算？因为相机一直在绕圈，"相机面前"每时每刻都在变 */
  function computePhotoExplodeTargets() {
    var n = photoItems.length;
    if (n === 0) return;
    var viewDist = Math.max(5, orbitDist * 0.45); // 照片簇离相机多远（比上一代 0.55 更近 = 更"怼脸"）
    var forward = new THREE.Vector3();
    camera.getWorldDirection(forward);            // 相机当前朝哪看
    /* 以相机朝向为基准，建一对"右方向/上方向"的坐标轴，用来散布照片 */
    var right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    var up = new THREE.Vector3().crossVectors(right, forward).normalize();

    photoItems.forEach(function (item) {
      var target = camera.position.clone().addScaledVector(forward, viewDist);
      /* 在中央区域里随机偏移：横向 ±2.4，纵向 ±1.7，松散的一小簇 */
      target.addScaledVector(right, (Math.random() - 0.5) * 4.8);
      target.addScaledVector(up, (Math.random() - 0.5) * 3.4);
      item.explode.copy(target);
      /* 每张放大倍数略有不同（3.1~3.7 倍）；手机站得远，
         要按比例放得更大，屏幕上看起来才一样大（viewDist/7 就是距离补偿） */
      item.explodeScale = (PHOTO_EXPLODE_SCALE + (Math.random() - 0.5) * 0.6) * (viewDist / 7);
    });
  }

  /* 清出"照片走廊"：炸开后，相机和照片簇之间连线周围是一根看不见的圆筒
     （半径 CORRIDOR_R）。落点掉进圆筒里的球，会被沿"垂直于走廊"的方向
     轻轻推出去（上下左右皆可）—— 照片主体永远不被球球遮挡 */
  function clearPhotoCorridor() {
    if (photoItems.length === 0) return;
    var a = camera.position.clone();      // 走廊起点：相机
    var b = new THREE.Vector3(0, 0, 0);   // 走廊终点：照片簇中心（各照片落点的平均）
    for (var i = 0; i < photoItems.length; i++) b.add(photoItems[i].explode);
    b.multiplyScalar(1 / photoItems.length);

    var ab = new THREE.Vector3().subVectors(b, a);
    var abLen2 = ab.lengthSq();
    if (abLen2 < 0.0001) return;

    for (var j = 0; j < floatItems.length; j++) {
      var item = floatItems[j];
      if (item.isPhoto) continue;
      var p = item.explode;
      /* p 在走廊线段上的"投影位置"t：0=相机处，1=照片簇处。
         头尾稍微放宽一点(-0.1~1.15)，镜头后面和照片背后也别堵着 */
      var t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / abLen2;
      if (t < -0.1 || t > 1.15) continue;
      var tc = clamp(t, 0, 1);
      var qx = a.x + ab.x * tc, qy = a.y + ab.y * tc, qz = a.z + ab.z * tc; // 走廊轴线上离 p 最近的点
      var dx = p.x - qx, dy = p.y - qy, dz = p.z - qz;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= CORRIDOR_R) continue;      // 在走廊外面，不用挪
      if (d < 0.001) { dx = 0; dy = 1; dz = 0; d = 1; } // 倒霉正好在轴线上：往上推
      var push = (CORRIDOR_R + Math.random() * 1.6) / d;
      p.set(qx + dx * push, qy + dy * push, qz + dz * push);
    }
  }

  /* ============================================================
    六、炸开 / 恢复 状态机（手势和降级按钮共用这一个开关）
    ------------------------------------------------------------
    核心思路（补间动画）：不瞬间跳变，而是在 EXPLODE_MS 毫秒内，
    让每个东西从"当前位置"平滑滑动到"目标位置"。
    动画途中再次触发也安全：把"当前位置"当作新起点，继续插值即可，
    就像开车掉头不用先刹停，直接打方向盘。
    ============================================================ */
  window.toggleCakeExplode = function (shouldExplode) {
    if (!ready) return;
    if (shouldExplode === exploded && !tweenActive) return; // 状态没变，不做无用功
    exploded = shouldExplode;

    if (exploded) {
      precomputeBallExplodeTargets(); // 每次炸开重新撒一遍落点（几百个随机数，眨眼算完）
      computePhotoExplodeTargets();   // 按"此刻"的相机位置算照片簇
      clearPhotoCorridor();           // 把挡在"照片↔相机走廊"里的球请出去
    }

    floatItems.forEach(function (item) {
      item.from.copy(item.cur);           // 起点 = 现在在哪（打断也平滑）
      item.to.copy(exploded ? item.explode : item.home);
      item.scaleFrom = item.curScale;
      item.scaleTo = exploded ? item.explodeScale : 1;
      item.rotFrom.x = item.curRotX;
      item.rotFrom.z = item.curRotZ;
      item.rotTo.x = exploded ? item.rotExplode.x : 0;
      item.rotTo.z = exploded ? item.rotExplode.z : 0;
    });
    tweenStart = performance.now();
    tweenActive = true;

    /* 通知音乐播放器撒一把星星音效（防御式：播放器不在就算了） */
    if (window.MusicPlayer && typeof window.MusicPlayer.onExplode === 'function') {
      try { window.MusicPlayer.onExplode(exploded); } catch (e) { /* 音效失败不影响动画 */ }
    }
  };

  /* ============================================================
    七、渲染循环：每帧跑一次（约 60 次/秒），负责 5 件小事
      1. 转相机   2. 推进补间动画   3. 加漂移+呼吸漂浮
      4. 招牌面向相机 + 火焰摇曳   5. 画出一帧
    ============================================================ */
  function animate() {
    requestAnimationFrame(animate); // 先约好下一帧，像闹钟定下一次响铃
    var now = performance.now();
    var tSec = now / 1000;

    /* 1. 相机绕 Y 轴慢慢转圈 + 极轻微的上下浮动（手持感，不呆板） */
    var ang = (tSec / ORBIT_SECONDS) * Math.PI * 2;
    camera.position.set(
      Math.sin(ang) * orbitDist,
      camHeight + Math.sin(tSec * 0.3) * 0.4,
      Math.cos(ang) * orbitDist
    );
    camera.lookAt(0, contentCenterY, 0); // 注视内容包围盒正中心：上下留白相等，不再"上空下挤"

    /* 2. 推进炸开/恢复补间动画 */
    if (tweenActive) {
      var t = Math.min(1, (now - tweenStart) / EXPLODE_MS);
      var e = easeOutCubic(t);
      for (var i = 0; i < floatItems.length; i++) {
        var item = floatItems[i];
        item.cur.lerpVectors(item.from, item.to, e); // 位置插值
        item.curScale = item.scaleFrom + (item.scaleTo - item.scaleFrom) * e;
        item.curRotX = item.rotFrom.x + (item.rotTo.x - item.rotFrom.x) * e;
        item.curRotZ = item.rotFrom.z + (item.rotTo.z - item.rotFrom.z) * e;
      }
      if (t >= 1) tweenActive = false; // 动画播完，省下之后的计算
    }

    /* 3. 每个东西的实际位置 = 动画位置 + 漂移偏移 + 呼吸漂浮偏移 */
    for (var j = 0; j < floatItems.length; j++) {
      var it = floatItems[j];
      it.group.position.copy(it.cur);
      /* 梦幻漂移：沿自己的方向向量缓缓来回游动。
         叠加在补间位置之上，所以蛋糕形态和炸开形态都生效 */
      if (it.driftAmp > 0) {
        var dOff = Math.sin(tSec * it.driftFreq + it.driftPhase) * it.driftAmp;
        it.group.position.x += it.driftDir.x * dOff;
        it.group.position.y += it.driftDir.y * dOff;
        it.group.position.z += it.driftDir.z * dOff;
      }
      it.group.position.y += Math.sin(tSec * it.bobSpeed + it.phase) * it.bobAmp;
      /* 缩放 = 原始缩放 × 动画缩放：小球的"半径"不会被动画吃掉 */
      it.group.scale.setScalar(it.baseScale * it.curScale);
      if (it.isPhoto) {
        /* 照片永远面向相机（像向日葵朝着太阳），再加一点随性倾斜 */
        it.group.lookAt(camera.position);
        it.group.rotateZ(it.tiltZ);
      } else {
        it.group.rotation.x = it.curRotX;
        it.group.rotation.z = it.curRotZ;
      }
    }

    /* 4a. 招牌们：只绕竖直轴转身面向相机（保持水平不歪头）。
       它们不在 floatItems 里，所以炸开时也纹丝不动地待在原处 */
    for (var k = 0; k < billboards.length; k++) {
      var plate = billboards[k];
      plate.rotation.y = Math.atan2(
        camera.position.x - plate.position.x,
        camera.position.z - plate.position.z
      );
    }

    /* 4b. 火焰摇曳：根部钉死在烛芯上（火焰组的 x/y/z 全程不动），
       只做三件事 —— 绕根部的微小倾斜 + 从根部向上的缩放脉动 + 亮度随机游走，
       叠起火苗就"活"了，而且任何角度看都不会偏离烛芯 */
    if (flameGroup) {
      /* 随机游走：每帧给"心情值"加一个小随机数，再夹回 0.7~1.0，
         像股票小幅波动，不会突然跳变 */
      flameFlicker += (Math.random() - 0.5) * 0.1;
      flameFlicker = clamp(flameFlicker, 0.7, 1.0);

      /* 绕根部倾斜（±0.06 弧度内）：旋转中心就是火焰组原点 = 烛芯顶端，
         所以越靠近火苗尖摆得越明显，根部纹丝不动。
         火苗高约 0.15，尖端最大摆幅 ≈ 0.15×0.051 ≈ 0.008，只有高度的 5% */
      flameGroup.rotation.z = Math.sin(tSec * 7.3) * 0.045 + (Math.random() - 0.5) * 0.012;
      flameGroup.rotation.x = Math.cos(tSec * 6.1) * 0.045 + (Math.random() - 0.5) * 0.012;

      /* 缩放脉动 0.9~1.15：以根部为锚点向上伸缩，
         拉高时顺便变细一点（真火苗蹿高时会变瘦） */
      var s = 0.9 + ((flameFlicker - 0.7) / 0.3) * 0.25;
      flameGroup.scale.set(1 - (s - 1) * 0.5, s, 1 - (s - 1) * 0.5);

      /* 灯光和光晕跟着心情值同步呼吸（迷你蜡烛配迷你暖灯，亮度也同比瘦身） */
      flameLight.intensity = 0.2 + flameFlicker * 0.35;   // 0.45~0.55 之间轻轻呼吸
      flameGlow.material.opacity = 0.55 + flameFlicker * 0.35; // 0.8~0.9
    }

    /* 5. 把这一帧画到屏幕上 */
    renderer.render(scene, camera);
  }

  /* 窗口大小变化（旋转手机、拖窗口）：重新匹配画布和相机比例，
     并按"同一套构图公式"重算注视点和距离 —— 转竖屏会自动站远，
     蛋糕底层依然完整在画面里、不被屏幕下缘裁切 */
  function onResize() {
    if (!renderer || !camera) return;
    camera.fov = window.innerWidth < 600 ? 62 : 55; // 和初始化同一条规则：窄屏视野角开大
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    fitCameraToContent(); // 注视点 = 内容中心，距离按新 fov/aspect 重算
  }
})();
