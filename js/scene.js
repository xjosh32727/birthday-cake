/* ============================================================
 * scene.js —— 3D 魔法赛博气球蛋糕场景（Three.js r128）
 * ------------------------------------------------------------
 * 这个文件负责四件事：
 *   1. 搭舞台：纯黑背景 + 满天星星（像把房间灯关掉，只留蛋糕上的烛光）
 *   2. 摆蛋糕：3~4 层"气球圆环"叠成蛋糕锥台 + 顶部 1 个大气球，
 *      气球之间特意留缝隙，能透过缝看到黑色星空（疏密适中）
 *   3. 放照片：把照片做成"拍立得"（白边 + 照片），插在气球空隙里，
 *      再挂一块发光名牌 "{name} · {age}岁"
 *   4. 炸开魔法：window.toggleCakeExplode() —— 气球四散飞开，
 *      照片飞到你面前排成弧形放大展示；再触发一次就平滑飞回去
 *
 * 对外只暴露两个函数（form.js 和 gesture.js 会调用）：
 *   - window.startCakeScene({name, age, photos, cameraStream})
 *   - window.toggleCakeExplode(exploded)   exploded=true 炸开 / false 恢复
 * ============================================================ */

(function () {
  'use strict';

  /* ============================================================
    一、可调参数区（想改效果，先改这里，每处都写了"改了会怎样"）
    ============================================================ */

  /* 糖果色盘：气球随机从中取色。想换风格就改色号，
     比如改成全粉系：0xff9ff3, 0xfecfef ... 随你发挥 */
  var CANDY_COLORS = [0xff6b9d, 0xffd93d, 0x6bcbff, 0x95ff6b, 0xc86bff, 0xff8c42];

  /* 蛋糕结构：从下到上每层摆几个气球（手机端会自动减半保帧率）。
     想让蛋糕更胖：把 LAYER_RADII 整体调大；想更高：加一层数字 */
  var LAYER_COUNTS = [24, 16, 10, 6];
  var LAYER_RADII  = [5.6, 4.1, 2.7, 1.5]; // 每层圆环的半径
  var LAYER_HEIGHT = 1.75;                  // 层与层的垂直距离（调大→蛋糕变高变瘦）
  var BASE_Y = 0.3;                         // 底层气球离"地面"的高度

  var BALLOON_RADIUS = 0.5;       // 气球基础半径（改大→气球挤在一起，改小→更稀疏）
  var TOP_BALLOON_SCALE = 1.7;    // 顶部大气球是普通气球的几倍大
  var STRING_LENGTH = 1.1;        // 气球下面那根细绳的长度

  var STAR_COUNT = 700;           // 星星数量（手机端减半）。想更梦幻改成 1200 试试
  var CENTER_Y = 2.7;             // 蛋糕的"心脏"高度：相机盯着它看，气球从它往外炸

  var ORBIT_SECONDS = 25;         // 相机绕蛋糕转一圈的秒数（改小→转得更快，会晕哦）
  var EXPLODE_MS = 1000;          // 炸开/恢复动画时长（0.8~1.2 秒之间最舒服）

  var PHOTO_MAX = 10;             // 最多上墙的照片数（太多了会挡蛋糕）
  var PHOTO_RING_RADIUS = 4.55;   // 照片环绕蛋糕的半径（要比最底层气球圈小一点，才像"插在空隙里"）
  var PHOTO_EXPLODE_SCALE = 2.5;  // 炸开后照片放大几倍（2~3 之间最好看）

  /* ============================================================
    二、内部状态（只初始化一次的"单例"零件）
    ============================================================ */
  var started = false;        // 防止 startCakeScene 被调用两次（单例锁）
  var scene, camera, renderer;
  var namePlate = null;       // 发光名牌（每帧要让它面向相机）
  var floatItems = [];        // 所有"会漂浮 + 会炸开"的东西（气球 + 照片）
  var photoItems = [];        // 只装照片（floatItems 的子集，炸开时单独算目标位）
  var orbitDist = 14;         // 相机到蛋糕中心的距离（初始化时按屏幕比例算）
  var camHeight = 5.7;        // 相机高度

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
    var name = String(opts.name || '寿星');
    var age = String(opts.age || '');
    var photos = Array.isArray(opts.photos) ? opts.photos : [];

    if (typeof THREE === 'undefined') {  // CDN 挂了也不能让页面崩掉
      console.warn('Three.js 没加载成功（可能断网了），3D 场景无法启动。');
      return;
    }

    var container = document.getElementById('scene-container');
    if (!container) return;

    /* 手机端性能保护：屏幕窄 = 大概率是手机，气球和星星减半，
     就像小厨房少开几个灶，照样能做菜还不卡 */
    var isMobile = window.innerWidth < 600;
    var balloonScaleFactor = isMobile ? 0.5 : 1;
    var starCount = isMobile ? Math.floor(STAR_COUNT / 2) : STAR_COUNT;

    /* ---------- 1. 场景 + 相机 + 渲染器 ---------- */
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // 纯黑背景：赛博感的底色

    /* 视野角(fov)：手机竖屏更窄，稍微开大一点(62°)才能装下整个蛋糕 */
    var fov = isMobile ? 62 : 55;
    camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 300);

    /* 相机距离：要保证"最宽的那层气球"正好能进画面。
     类比：拍照时人离蛋糕多远，取决于你的镜头有多宽（aspect）。
     竖屏手机 aspect 小 → 要站远一点；电脑宽屏 → 可以站近点 */
    var fitHalfWidth = LAYER_RADII[0] + BALLOON_RADIUS * 1.2 + 0.6; // 蛋糕最宽处的一半 + 一点边距
    var halfFovTan = Math.tan((fov / 2) * Math.PI / 180);
    orbitDist = clamp(fitHalfWidth / (halfFovTan * camera.aspect), 10, 26);

    renderer = new THREE.WebGLRenderer({ antialias: !isMobile }); // 手机关抗锯齿省电
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // 高分屏最多 2 倍，再高性能浪费
    renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(renderer.domElement);

    /* ---------- 2. 灯光 ----------
     环境光 = 房间的"基础亮度"，让所有东西不至于死黑；
     两盏彩色点光 = 夜店里的青色/品红射灯，打出赛博霓虹感 */
    scene.add(new THREE.AmbientLight(0xbbbbbb, 0.75));
    var cyanLight = new THREE.PointLight(0x00ffff, 0.9, 60);
    cyanLight.position.set(8, 10, 8);
    scene.add(cyanLight);
    var magentaLight = new THREE.PointLight(0xff00ff, 0.8, 60);
    magentaLight.position.set(-8, 6, -8);
    scene.add(magentaLight);

    /* ---------- 3. 星空 ---------- */
    buildStarfield(starCount);

    /* ---------- 4. 气球蛋糕 ---------- */
    buildBalloonCake(balloonScaleFactor);

    /* ---------- 5. 照片拍立得（没照片就跳过） ---------- */
    if (photos.length > 0) {
      buildPhotos(photos.slice(0, PHOTO_MAX));
    }

    /* ---------- 6. 发光名牌 ---------- */
    namePlate = buildNamePlate(name, age);
    scene.add(namePlate);

    /* ---------- 7. 预计算所有气球的"炸开落点" ----------
     为什么提前算好？因为炸开那一刻再算 57 个随机数会卡一下，
     提前存好，触发时直接"照单执行"，动画丝般顺滑 */
    precomputeBalloonExplodeTargets();

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

  /* 气球蛋糕：一层一层摆气球圆环 */
  function buildBalloonCake(scaleFactor) {
    /* 几何体和材质尽量"共用"：57 个气球共用 1 个球体模型 + 6 个颜色材质，
     就像用同一个模具烤 57 块饼干，省内存、渲染快 */
    var balloonGeo = new THREE.SphereGeometry(BALLOON_RADIUS, 20, 16);
    var stringGeo = new THREE.CylinderGeometry(0.008, 0.008, STRING_LENGTH, 5);
    var stringMat = new THREE.MeshBasicMaterial({ color: 0x666666 });
    var balloonMats = CANDY_COLORS.map(function (c) {
      return new THREE.MeshPhongMaterial({
        color: c,
        emissive: c,            // 自发光：气球在黑暗里自己微微发亮，像霓虹灯管
        emissiveIntensity: 0.35,// 0=不发光 1=亮瞎眼，0.35 是"微微透光"的甜点区
        shininess: 60,
        specular: 0x555555
      });
    });

    for (var layer = 0; layer < LAYER_COUNTS.length; layer++) {
      /* 手机端每层气球数减半，但最少留 3 个，不然看不出是圆环 */
      var count = Math.max(3, Math.round(LAYER_COUNTS[layer] * scaleFactor));
      var radius = LAYER_RADII[layer];
      var y = BASE_Y + layer * LAYER_HEIGHT;
      /* 相邻两层错开半个角度，像砌砖一样交错，看起来更自然 */
      var angleOffset = (layer % 2) * (Math.PI / count);

      for (var j = 0; j < count; j++) {
        var angle = (j / count) * Math.PI * 2 + angleOffset;
        /* 半径加一点点随机抖动，避免"军训队列"般的死板 */
        var r = radius + (Math.random() - 0.5) * 0.3;
        addBalloon(
          Math.cos(angle) * r,
          y + (Math.random() - 0.5) * 0.2,
          Math.sin(angle) * r,
          0.9 + Math.random() * 0.25, // 大小也随机一点点
          balloonGeo, stringGeo, stringMat, balloonMats
        );
      }
    }

    /* 顶部大气球：蛋糕的"樱桃" */
    var topY = BASE_Y + LAYER_COUNTS.length * LAYER_HEIGHT;
    addBalloon(0, topY, 0, TOP_BALLOON_SCALE, balloonGeo, stringGeo, stringMat, balloonMats);
  }

  /* 造一个气球 = 球体 + 细绳，装进一个"小组"(Group)里。
     为什么用 Group？之后移动/旋转气球时，绳子和球一起动，不用各管各的 */
  function addBalloon(x, y, z, scale, balloonGeo, stringGeo, stringMat, balloonMats) {
    var group = new THREE.Group();
    var mat = balloonMats[Math.floor(Math.random() * balloonMats.length)]; // 随机挑个糖果色
    var balloon = new THREE.Mesh(balloonGeo, mat);
    balloon.scale.setScalar(scale);
    group.add(balloon);

    var string = new THREE.Mesh(stringGeo, stringMat);
    /* 绳子挂在气球正下方：气球半径*缩放 + 半根绳长 */
    string.position.y = -(BALLOON_RADIUS * scale + STRING_LENGTH / 2);
    group.add(string);

    group.position.set(x, y, z);
    scene.add(group);
    floatItems.push(makeFloatItem(group, false));
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

      /* 均匀环绕蛋糕 + 高度错开三层，插在气球之间的空隙里 */
      var angle = (i / n) * Math.PI * 2 + Math.PI / n;
      var y = 1.2 + (i % 3) * 1.7;
      group.position.set(Math.cos(angle) * PHOTO_RING_RADIUS, y, Math.sin(angle) * PHOTO_RING_RADIUS);
      scene.add(group);

      var item = makeFloatItem(group, true);
      floatItems.push(item);
      photoItems.push(item);
    });
  }

  /* 发光名牌：离屏 canvas 当"画板"，写上霓虹字，再贴到平面上悬浮起来 */
  function buildNamePlate(name, age) {
    var canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    var ctx = canvas.getContext('2d');

    var mainText = name + ' · ' + age + '岁';
    /* 名字太长就自动缩小字号：从 130px 开始量，塞不进 920px 就减 10 再量 */
    var fontSize = 130;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    do {
      ctx.font = 'bold ' + fontSize + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
      if (ctx.measureText(mainText).width <= 920) break;
      fontSize -= 10;
    } while (fontSize > 40);

    /* 霓虹发光秘诀：shadowBlur 就是"光晕半径"，同一行字画两遍光更浓 */
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 45;              // 想光晕更大就调大它
    ctx.fillStyle = '#eaffff';
    ctx.fillText(mainText, 512, 200);
    ctx.fillText(mainText, 512, 200); // 第二遍：光晕叠加更亮

    ctx.font = 'bold 64px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.shadowColor = '#ff00ff';
    ctx.shadowBlur = 35;
    ctx.fillStyle = '#ffeaff';
    ctx.fillText('— Happy Birthday —', 512, 370);
    ctx.fillText('— Happy Birthday —', 512, 370);

    var tex = new THREE.CanvasTexture(canvas);
    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,   // 透明底：只显示字，不显示 canvas 的黑背景
      side: THREE.DoubleSide,
      depthWrite: false
    });
    var plate = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 3.6), mat);
    var topY = BASE_Y + LAYER_COUNTS.length * LAYER_HEIGHT;
    plate.position.set(0, topY + 1.7, 0); // 悬浮在顶部大气球上方
    return plate;
  }

  /* ============================================================
    五、"会漂浮会炸开"的东西的统一档案
    ------------------------------------------------------------
    每个气球/照片都建一份档案，记录：
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
      curScale: 1, scaleFrom: 1, scaleTo: 1, explodeScale: 1,
      curRotX: 0, curRotZ: 0,
      rotFrom: { x: 0, z: 0 }, rotTo: { x: 0, z: 0 },
      rotExplode: { x: 0, z: 0 },
      /* 呼吸参数：相位错开，气球们才不会"集体做广播体操" */
      phase: Math.random() * Math.PI * 2,
      bobAmp: 0.10 + Math.random() * 0.08,  // 漂浮幅度（想飘得更明显就调大）
      bobSpeed: 0.8 + Math.random() * 0.6,  // 漂浮速度
      tiltZ: (Math.random() - 0.5) * 0.3    // 照片专用：一点点歪，像随手贴的拍立得
    };
  }

  /* 气球炸开落点：沿"蛋糕中心 → 自己"的方向飞出去 2.5~4 倍距离 + 随机抖动 */
  function precomputeBalloonExplodeTargets() {
    var center = new THREE.Vector3(0, CENTER_Y, 0);
    floatItems.forEach(function (item) {
      if (item.isPhoto) return; // 照片的落点要在炸开那一刻按相机位置算
      var dir = item.home.clone().sub(center);
      var len = dir.length() || 1;
      dir.normalize();
      item.explode.copy(item.home).addScaledVector(dir, len * (2.6 + Math.random() * 1.2));
      item.explode.x += (Math.random() - 0.5) * 1.6;
      item.explode.y += (Math.random() - 0.5) * 1.6;
      item.explode.z += (Math.random() - 0.5) * 1.6;
      item.rotExplode.x = (Math.random() - 0.5) * 0.9; // 飞出去时轻微翻滚
      item.rotExplode.z = (Math.random() - 0.5) * 0.9;
    });
  }

  /* 照片炸开落点：飞到"相机面前"排成一道弧形墙，面向你展示。
     为什么不在初始化时算？因为相机一直在绕圈，"相机面前"每时每刻都在变，
     所以弧形的"相对排布"规则写死，具体世界坐标在触发瞬间按当时相机位置算 */
  function computePhotoExplodeTargets() {
    var n = photoItems.length;
    if (n === 0) return;
    var viewDist = Math.max(6, orbitDist * 0.55); // 照片墙离相机多远（比蛋糕近，才有"怼脸展示"感）
    var forward = new THREE.Vector3();
    camera.getWorldDirection(forward);            // 相机当前朝哪看
    var upAxis = new THREE.Vector3(0, 1, 0);
    /* 弧形总张角：照片越多张角越大，但封顶 1.8 弧度（约 103°），不然两边照片绕到你背后了 */
    var spread = Math.min((n - 1) * 0.38 * (7 / viewDist), 1.8);

    photoItems.forEach(function (item, i) {
      var ang = n === 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
      var dir = forward.clone().applyAxisAngle(upAxis, ang); // 把"正前方"绕竖直轴转一点
      var target = camera.position.clone().addScaledVector(dir, viewDist);
      target.y += (i % 2 === 0 ? 0.45 : -0.45);              // 一上一下交错，更像照片墙
      item.explode.copy(target);
      /* 手机站得远，照片要按比例放得更大，屏幕上看起来才一样大 */
      item.explodeScale = PHOTO_EXPLODE_SCALE * (viewDist / 7);
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

    if (exploded) computePhotoExplodeTargets(); // 按"此刻"的相机位置算照片墙

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
    七、渲染循环：每帧跑一次（约 60 次/秒），负责 4 件小事
      1. 转相机   2. 推进补间动画   3. 加呼吸漂浮   4. 画出一帧
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
      it.group.scale.setScalar(it.curScale);
      if (it.isPhoto) {
        /* 照片永远面向相机（像向日葵朝着太阳），再加一点随性倾斜 */
        it.group.lookAt(camera.position);
        it.group.rotateZ(it.tiltZ);
      } else {
        it.group.rotation.x = it.curRotX;
        it.group.rotation.z = it.curRotZ;
      }
    }

    /* 名牌：只绕竖直轴转身面向相机（保持水平不歪头），并轻轻上下浮动 */
    if (namePlate) {
      namePlate.rotation.y = Math.atan2(
        camera.position.x - namePlate.position.x,
        camera.position.z - namePlate.position.z
      );
      namePlate.position.y = BASE_Y + LAYER_COUNTS.length * LAYER_HEIGHT + 1.7 + Math.sin(tSec * 0.7) * 0.15;
    }

    /* 4. 把这一帧画到屏幕上 */
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
