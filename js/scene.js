/* ============================================================
 * scene.js —— 3D 珍珠球生日蛋糕场景（Three.js r128）
 * ------------------------------------------------------------
 * 这个文件负责五件事：
 *   1. 搭舞台：纯黑背景 + 满天星星（像把房间灯关掉，只留蛋糕上的烛光）
 *   2. 堆蛋糕：数百个晶莹发光的小圆球（像玻璃珠/珍珠）堆成 5 层圆丘蛋糕，
 *      球与球之间留一点缝隙，能透出后面的星光
 *   3. 立招牌：蛋糕上方从下到上依次是 —— 发光岁数数字、蜡烛+跳动火焰、
 *      寿星名字、金色衬线字 "Happy Birthday"（全都永远面向你）
 *   4. 放照片：照片做成"拍立得"（白边+照片），点缀在球丘四周
 *   5. 炸开魔法：window.toggleCakeExplode() —— 小球像泡泡海洋一样
 *      炸满整个画面，照片飞到你面前放大展示；再触发一次就平滑飞回去
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

  /* 珍珠色盘：小球随机从中取色，整体是"温暖糖果店"的感觉。
     想换风格就改色号，比如改成全粉系：0xff9ff3, 0xfecfef ... 随你发挥 */
  var PEARL_COLORS = [
    0xff5e5b, // 珊瑚红
    0xffc53d, // 金
    0x7bd88f, // 蜜瓜绿
    0x5cc8ff, // 天蓝
    0xb892ff, // 紫
    0xff8fab, // 粉
    0xff9f43, // 琥珀
    0xfff3e0  // 奶白
  ];

  /* 蛋糕结构：5 层圆丘，从下到上逐层收窄（手机端球数自动×0.45保帧率）。
     count = 这一层摆多少个球；radius = 这一层的圆盘半径；y = 这一层的高度。
     想让蛋糕更胖：把 radius 整体调大；想更高：把 y 间距拉大 */
  var LAYERS = [
    { radius: 4.4, y: 0.50, count: 108 },
    { radius: 3.6, y: 1.25, count: 84 },
    { radius: 2.8, y: 1.95, count: 61 },
    { radius: 2.0, y: 2.60, count: 41 },
    { radius: 1.25, y: 3.20, count: 26 }
  ];                                        // 桌面端总计约 320 个球（手机端约 145 个）

  var BALL_R_MIN = 0.12;  // 最小球半径（改大→没有"小碎钻"的层次感）
  var BALL_R_MAX = 0.35;  // 最大球半径（改大→球丘更臃肿，小心互相穿插）
  var GLASS_RATIO = 0.22; // "玻璃珠"占比：0.22 = 大约每 5 个球里有 1 个半透明
  var BALL_EMISSIVE = 0.28; // 小球自发光强度：0=不发光 1=亮瞎眼，0.28 是"微微透光"的甜点区

  var STAR_COUNT = 700;   // 星星数量（手机端减半）。想更梦幻改成 1200 试试
  var CENTER_Y = 3.6;     // 蛋糕的"心脏"高度：相机盯着它看，小球从它往外炸

  var ORBIT_SECONDS = 25; // 相机绕蛋糕转一圈的秒数（改小→转得更快，会晕哦）
  var EXPLODE_MS = 1000;  // 炸开/恢复动画时长（0.8~1.2 秒之间最舒服）

  var PHOTO_MAX = 10;           // 最多上墙的照片数（太多了会挡蛋糕）
  var PHOTO_EXPLODE_SCALE = 2.3; // 炸开后照片放大的基准倍数（2~2.5 之间最好看）

  /* 炸开后小球的散布范围：以蛋糕中心为球心的大球壳，半径约为蛋糕的 3~6 倍，
     这样前后左右都飞满，屏幕上才是"球海"而不是"球雾" */
  var EXPLODE_R_MIN = 13; // 飞得最近的球离中心多远
  var EXPLODE_R_MAX = 24; // 飞得最远的球（别超过相机远裁剪面 300，放心）

  /* ============================================================
    二、内部状态（只初始化一次的"单例"零件）
    ============================================================ */
  var started = false;        // 防止 startCakeScene 被调用两次（单例锁）
  var scene, camera, renderer;
  var billboards = [];        // 所有"每帧要面向相机"的平面（标题/名字/岁数）
  var floatItems = [];        // 所有"会漂浮 + 会炸开"的东西（小球 + 照片）
  var photoItems = [];        // 只装照片（floatItems 的子集，炸开时单独算目标位）
  var orbitDist = 14;         // 相机到蛋糕中心的距离（初始化时按屏幕比例算）
  var camHeight = 4.3;        // 相机高度

  /* 蜡烛火焰相关的零件（每帧摇曳动画要用） */
  var flameGroup = null;      // 火焰整体（内焰+外焰+光晕+点光源都挂它身上）
  var flameLight = null;      // 火焰的暖色点光源
  var flameGlow = null;       // 火焰光晕贴片
  var flameBaseY = 0;         // 火焰静止时的高度（摇曳是在此基础上偏移）
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

    /* 相机距离：要保证"最宽的那层球丘"正好能进画面。
     类比：拍照时人离蛋糕多远，取决于你的镜头有多宽（aspect）。
     竖屏手机 aspect 小 → 要站远一点；电脑宽屏 → 可以站近点 */
    var fitHalfWidth = LAYERS[0].radius + BALL_R_MAX + 0.6; // 蛋糕最宽处的一半 + 一点边距
    var halfFovTan = Math.tan((fov / 2) * Math.PI / 180);
    orbitDist = clamp(fitHalfWidth / (halfFovTan * camera.aspect), 11, 26);

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

    /* ---------- 4. 珍珠球蛋糕 ---------- */
    buildBallCake(ballScaleFactor);

    /* ---------- 5. 照片拍立得（没照片就跳过） ---------- */
    if (photos.length > 0) {
      buildPhotos(photos.slice(0, PHOTO_MAX));
    }

    /* ---------- 6. 招牌区：岁数数字 → 蜡烛火焰 → 名字 → 标题 ----------
       从下到上叠在蛋糕上方，全部加入 billboards，每帧面向相机 */
    var cakeTopY = LAYERS[LAYERS.length - 1].y + BALL_R_MAX + 0.15; // 球丘顶端

    if (age !== '') {
      var agePlate = buildAgePlate(age);
      agePlate.position.set(0, cakeTopY + 0.62, 0); // 紧贴顶部球层
      scene.add(agePlate);
      billboards.push(agePlate);
    }

    buildCandle(cakeTopY + 1.15); // 蜡烛站在岁数数字正上方

    var namePlate = buildTextPlate({
      text: name,
      fontStack: '"Playfair Display", Didot, "Bodoni MT", Georgia, "Microsoft YaHei", serif',
      fontSize: 96,
      fillStyle: '#ffefd0',   // 浅金近白：比标题低调，不抢戏
      glowColor: '#d4af37',
      glowBlur: 26,
      planeW: 5.4,
      planeH: 1.25
    });
    namePlate.position.set(0, cakeTopY + 3.35, 0);
    scene.add(namePlate);
    billboards.push(namePlate);

    var titlePlate = buildTextPlate({
      text: 'Happy Birthday',
      fontStack: '"Playfair Display", Didot, "Bodoni MT", Georgia, serif',
      fontSize: 148,
      fillStyle: '#d4af37',   // 经典金色：像烫金贺卡
      glowColor: '#ffd700',
      glowBlur: 34,           // 想金色光晕更大就调大它
      planeW: 8.2,
      planeH: 1.9
    });
    titlePlate.position.set(0, cakeTopY + 4.55, 0);
    scene.add(titlePlate);
    billboards.push(titlePlate);

    /* ---------- 7. 预计算所有小球的"炸开落点" ----------
     为什么提前算好？因为炸开那一刻再算 300 多个随机数会卡一下，
     提前存好，触发时直接"照单执行"，动画丝般顺滑 */
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

  /* 珍珠球蛋糕：几百个小圆球堆成 5 层圆丘 */
  function buildBallCake(scaleFactor) {
    /* 几何体和材质尽量"共用"：300 多个球共用 1 个球体模型 + 十几种材质，
     就像用同一个模具烤一炉饼干，省内存、渲染快。
     注意：模型半径做成 1，每个球用自己的缩放当半径，灵活又省钱 */
    var ballGeo = new THREE.SphereGeometry(1, 18, 14);

    /* 两套材质：
       ① 珍珠款：不透明、高光强（shininess 高 = 表面像瓷器一样有一个亮亮的光斑）
       ② 玻璃珠款：半透明（opacity 0.75~0.9），混在里面像掺了几颗水果硬糖 */
    var pearlMats = PEARL_COLORS.map(function (c) {
      return new THREE.MeshPhongMaterial({
        color: c,
        emissive: c,                  // 自发光：球在黑暗里自己微微发亮
        emissiveIntensity: BALL_EMISSIVE,
        shininess: 90,                // 想高光更锐利就调到 100，更哑光就降到 60
        specular: 0xeeeeee            // 高光颜色接近白，才有"玻璃反光"感
      });
    });
    var glassMats = PEARL_COLORS.map(function (c) {
      return new THREE.MeshPhongMaterial({
        color: c,
        emissive: c,
        emissiveIntensity: BALL_EMISSIVE,
        shininess: 100,
        specular: 0xffffff,
        transparent: true,
        opacity: 0.75 + Math.random() * 0.15 // 每个玻璃珠透明度都不一样，更自然
      });
    });

    for (var layer = 0; layer < LAYERS.length; layer++) {
      var def = LAYERS[layer];
      var count = Math.max(8, Math.round(def.count * scaleFactor));

      for (var j = 0; j < count; j++) {
        /* 在圆盘里均匀随机取点：sqrt 是数学小技巧，
           不加它球会全挤在圆心，像没搅开的芝麻糊 */
        var rr = Math.sqrt(Math.random()) * def.radius;
        var ang = Math.random() * Math.PI * 2;
        /* 圆心处稍微垫高一点，层与层之间形成微微鼓起的"圆丘"弧度 */
        var dome = (1 - rr / def.radius) * 0.35;
        var y = def.y + dome + (Math.random() - 0.5) * 0.22; // 抖动：避免军训队列般的死板

        var ballR = BALL_R_MIN + Math.random() * (BALL_R_MAX - BALL_R_MIN);
        /* 一小部分球用半透明玻璃材质，其余用珍珠材质 */
        var mat = Math.random() < GLASS_RATIO
          ? glassMats[Math.floor(Math.random() * glassMats.length)]
          : pearlMats[Math.floor(Math.random() * pearlMats.length)];

        var ball = new THREE.Mesh(ballGeo, mat);
        ball.scale.setScalar(ballR);
        ball.position.set(Math.cos(ang) * rr, y, Math.sin(ang) * rr);
        scene.add(ball);

        var item = makeFloatItem(ball, false);
        item.baseScale = ballR; // 小球的"原始缩放"就是它的半径，动画缩放要乘在它上面
        item.bobAmp = 0.025 + Math.random() * 0.03; // 球的呼吸极轻微，像水母轻轻 pulsation
        floatItems.push(item);
      }
    }
  }

  /* 照片拍立得：白边底板 + 照片贴面（前置 0.01 防止两个平面"打架闪屏"） */
  function buildPhotos(photos) {
    var frameGeo = new THREE.PlaneGeometry(1.15, 1.4);  // 白边底板（比照片大一圈 = 拍立得的白边）
    var photoGeo = new THREE.PlaneGeometry(0.95, 0.95); // 照片本体
    var frameMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    var loader = new THREE.TextureLoader();
    var n = photos.length;

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

      /* 点缀在球丘四周：均匀环绕 + 高度错开三层，半径比球丘略小一点，
         看起来像"插"在球球之间的空隙里 */
      var angle = (i / n) * Math.PI * 2 + Math.PI / n;
      var y = 0.9 + (i % 3) * 1.1;
      group.position.set(Math.cos(angle) * 3.9, y, Math.sin(angle) * 3.9);
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

  /* 岁数数字：发光白色数字，贴在蛋糕丘顶端 */
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
    return new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.05), mat);
  }

  /* 蜡烛 + 火焰：岁数数字正上方的那一点暖光 */
  function buildCandle(baseY) {
    /* 蜡烛杆：细细的粉白圆柱 */
    var candleGeo = new THREE.CylinderGeometry(0.11, 0.13, 1.0, 16);
    var candleMat = new THREE.MeshPhongMaterial({
      color: 0xfff0f3,   // 粉白色，想纯白改成 0xffffff
      shininess: 50,
      specular: 0x888888
    });
    var candle = new THREE.Mesh(candleGeo, candleMat);
    candle.position.set(0, baseY + 0.5, 0);
    scene.add(candle);

    /* 烛芯：顶部一小截黑色细圆柱 */
    var wickGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.14, 6);
    var wickMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    var wick = new THREE.Mesh(wickGeo, wickMat);
    wick.position.set(0, baseY + 1.05, 0);
    scene.add(wick);

    /* 火焰 = 三层套娃，全挂在一个"火焰小组"里，摇曳时一起动：
       ① 内焰：亮黄白小水滴（圆锥），最亮最热
       ② 外焰：橙红稍大半透明圆锥，像火苗外面那圈橙光
       ③ 光晕：一片永远面向你的发光贴片（Sprite）+ 一盏小暖灯 */
    flameBaseY = baseY + 1.14;
    flameGroup = new THREE.Group();
    flameGroup.position.set(0, flameBaseY, 0);

    var innerGeo = new THREE.ConeGeometry(0.07, 0.26, 12);
    var innerMat = new THREE.MeshBasicMaterial({ color: 0xfff6b8 }); // 亮黄白
    var inner = new THREE.Mesh(innerGeo, innerMat);
    inner.position.y = 0.13;
    flameGroup.add(inner);

    var outerGeo = new THREE.ConeGeometry(0.15, 0.44, 12);
    var outerMat = new THREE.MeshBasicMaterial({
      color: 0xff7a2a,      // 橙红
      transparent: true,
      opacity: 0.5,         // 半透明，才像"光"而不是"塑料"
      depthWrite: false
    });
    var outer = new THREE.Mesh(outerGeo, outerMat);
    outer.position.y = 0.18;
    flameGroup.add(outer);

    /* 光晕贴片：canvas 上画一个径向渐变圆（中间亮白 → 边缘透明），
       Sprite 的特点是永远正对镜头，像贴在镜头上的柔光滤镜 */
    var glowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending, // 叠加发光：亮处更亮，黑色部分完全消失
      depthWrite: false
    });
    flameGlow = new THREE.Sprite(glowMat);
    flameGlow.scale.set(1.6, 1.6, 1); // 想光晕更大就调大这两个数
    flameGlow.position.y = 0.2;
    flameGroup.add(flameGlow);

    /* 火焰专属小暖灯：distance=8 表示光照到 8 格远就衰减没了，
       只照亮蜡烛附近的球球，不会把整个场景打成白天 */
    flameLight = new THREE.PointLight(0xffa050, 1.2, 8, 2);
    flameLight.position.y = 0.25;
    flameGroup.add(flameLight);

    scene.add(flameGroup);
  }

  /* 画一张"径向渐变发光圆"贴图：中心亮白 → 橙黄 → 完全透明 */
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
    每帧渲染时：位置 = cur + 正弦漂浮偏移，动画和呼吸互不干扰
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
      /* 呼吸参数：相位错开，小球们才不会"集体做广播体操" */
      phase: Math.random() * Math.PI * 2,
      bobAmp: 0.08 + Math.random() * 0.05,  // 漂浮幅度（照片用；小球建好后会覆盖成更小值）
      bobSpeed: 0.8 + Math.random() * 0.6,  // 漂浮速度
      tiltZ: (Math.random() - 0.5) * 0.3    // 照片专用：一点点歪，像随手贴的拍立得
    };
  }

  /* 小球炸开落点：以蛋糕中心为球心，随机方向 + 随机距离（13~24），
     整个大球壳里撒满 —— 前后左右都有球飞过来，屏幕才被"球海"填满 */
  function precomputeBallExplodeTargets() {
    var center = new THREE.Vector3(0, CENTER_Y, 0);
    floatItems.forEach(function (item) {
      if (item.isPhoto) return; // 照片的落点要在炸开那一刻按相机位置算
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1); // 球面均匀分布的老朋友
      var dist = EXPLODE_R_MIN + Math.random() * (EXPLODE_R_MAX - EXPLODE_R_MIN);
      item.explode.set(
        center.x + dist * Math.sin(phi) * Math.cos(theta),
        center.y + dist * Math.cos(phi),
        center.z + dist * Math.sin(phi) * Math.sin(theta)
      );
      item.rotExplode.x = (Math.random() - 0.5) * 2.4; // 飞出去时带随机翻滚
      item.rotExplode.z = (Math.random() - 0.5) * 2.4;
    });
  }

  /* 照片炸开落点：飞到"相机正前方的中央区域"，松松垮垮聚成一簇。
     故意不排整齐 —— 横七竖八才像撒在空中的一叠拍立得。
     为什么不在初始化时算？因为相机一直在绕圈，"相机面前"每时每刻都在变 */
  function computePhotoExplodeTargets() {
    var n = photoItems.length;
    if (n === 0) return;
    var viewDist = Math.max(6, orbitDist * 0.55); // 照片簇离相机多远（比蛋糕近，才有"怼脸展示"感）
    var forward = new THREE.Vector3();
    camera.getWorldDirection(forward);            // 相机当前朝哪看
    /* 以相机朝向为基准，建一对"右方向/上方向"的坐标轴，用来散布照片 */
    var right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    var up = new THREE.Vector3().crossVectors(right, forward).normalize();

    photoItems.forEach(function (item) {
      var target = camera.position.clone().addScaledVector(forward, viewDist);
      /* 在中央区域里随机偏移：横向 ±2.6，纵向 ±1.8，就像随手撒出去的一把照片 */
      target.addScaledVector(right, (Math.random() - 0.5) * 5.2);
      target.addScaledVector(up, (Math.random() - 0.5) * 3.6);
      item.explode.copy(target);
      /* 每张放大倍数略有不同（2.0~2.5 倍）；手机站得远，
         要按比例放得更大，屏幕上看起来才一样大 */
      item.explodeScale = (PHOTO_EXPLODE_SCALE + (Math.random() - 0.5) * 0.5) * (viewDist / 7);
    });
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

    if (exploded) computePhotoExplodeTargets(); // 按"此刻"的相机位置算照片簇

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
      1. 转相机   2. 推进补间动画   3. 加呼吸漂浮
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
    camera.lookAt(0, CENTER_Y, 0);

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

    /* 3. 每个东西的实际位置 = 动画位置 + 呼吸漂浮偏移 */
    for (var j = 0; j < floatItems.length; j++) {
      var it = floatItems[j];
      it.group.position.copy(it.cur);
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

    /* 4b. 火焰摇曳：位置轻轻晃 + 缩放脉动 + 亮度随机游走，
       三件事叠加起来，火苗就"活"了 */
    if (flameGroup) {
      /* 随机游走：每帧给"心情值"加一个小随机数，再夹回 0.7~1.0，
         像股票小幅波动，不会突然跳变 */
      flameFlicker += (Math.random() - 0.5) * 0.1;
      flameFlicker = clamp(flameFlicker, 0.7, 1.0);

      flameGroup.position.x = Math.sin(tSec * 7.3) * 0.03 + (Math.random() - 0.5) * 0.02;
      flameGroup.position.z = Math.cos(tSec * 6.1) * 0.03 + (Math.random() - 0.5) * 0.02;
      flameGroup.position.y = flameBaseY + Math.sin(tSec * 11) * 0.015;

      /* 心情值 0.7→缩放 0.9，1.0→缩放 1.15（火苗一伸一缩） */
      var s = 0.9 + ((flameFlicker - 0.7) / 0.3) * 0.25;
      flameGroup.scale.set(s, s, s);

      /* 灯光和光晕跟着心情值同步呼吸 */
      flameLight.intensity = 1.4 * flameFlicker;
      flameGlow.material.opacity = 0.7 + (flameFlicker - 0.7); // 0.7~1.0
    }

    /* 5. 把这一帧画到屏幕上 */
    renderer.render(scene, camera);
  }

  /* 窗口大小变化（旋转手机、拖窗口）：重新匹配画布和相机比例 */
  function onResize() {
    if (!renderer || !camera) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
})();
