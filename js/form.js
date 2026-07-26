/* ============================================================
 * form.js —— 开场录入页的全部交互逻辑
 * ------------------------------------------------------------
 * 这个文件负责四件事：
 *   1. 姓名/年龄必填校验（没填：红框 + 抖动提醒，像严格的检票员）
 *   2. 照片上传：压缩后存进浏览器"小仓库" localStorage，刷新也不丢
 *   3. 摄像头授权流程（手势魔法要靠它），被拒时给出"降级模式"入口
 *   4. 一切就绪后，把入场资料交给 window.startCakeScene()
 *      （3D 蛋糕场景由后续任务实现，这里只做"有就调用、没有就提示"）
 *
 * 注意：本文件不依赖任何第三方库，即使 CDN 挂了（比如断网），
 *       录入页依然能正常填写和校验。
 * ============================================================ */

(function () {
  'use strict';

  /* ---------------- 可调参数（想改行为，先改这里） ---------------- */

  /* 预置照片的文件名列表（照片本体放在 assets/photos/ 文件夹里）。
     现在是空数组 = 暂时没有预置照片。
     以后想加预置照片：把图片文件放进 assets/photos/，
     再把文件名写进这个数组即可，例如：
       var PRESET_PHOTOS = ['cake-1.jpg', 'party-2.jpg'];
     预置照片会标注"预置"且不可删除；文件不存在时会自动跳过（静默容错）。 */
  var PRESET_PHOTOS = [];

  var STORAGE_KEY = 'bday_photos'; // 照片在 localStorage 里的"货架编号"
  var MAX_PHOTO_EDGE = 800;        // 照片最长边压到 800px（原图太大，小仓库装不下）
  var JPEG_QUALITY = 0.8;          // JPEG 压缩质量 0~1，0.8 是清晰度和体积的平衡点

  /* ---------------- 抓取页面元素 ----------------
     脚本写在 index.html 的 </body> 之前，执行到这里时页面元素已经存在，
     所以可以直接 getElementById，不用等"页面加载完成"事件 */
  var introScreen     = document.getElementById('intro-screen');
  var nameInput       = document.getElementById('name-input');
  var ageInput        = document.getElementById('age-input');
  var photoInput      = document.getElementById('photo-input');
  var photoList       = document.getElementById('photo-list');
  var enterBtn        = document.getElementById('enter-btn');
  var cameraDenied    = document.getElementById('camera-denied');
  var skipCameraBtn   = document.getElementById('skip-camera-btn');
  var sceneContainer  = document.getElementById('scene-container');
  var camPreview      = document.getElementById('cam-preview');
  var gestureFallback = document.getElementById('gesture-fallback');
  var explodeToggle   = document.getElementById('explode-toggle');

  // 内存中的用户照片数组（base64 字符串），任何改动都会同步进 localStorage
  var userPhotos = loadUserPhotos();

  /* ============================================================
     一、照片的存取（localStorage）
     ============================================================ */

  /* localStorage 是什么？
     浏览器自带的一个"小仓库"，只能存文字（一般上限 5MB 左右），
     关掉网页再打开，里面的东西还在 —— 照片就靠它"记住"。 */
  function loadUserPhotos() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      // 隐私模式等极端情况下 localStorage 可能不可用，不能让页面因此崩掉
      console.warn('读取本地照片失败（不影响使用）：', e);
      return [];
    }
  }

  function saveUserPhotos() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userPhotos));
    } catch (e) {
      // 照片太多超过仓库上限时会走到这里：明着告诉用户，而不是悄悄丢数据
      alert('Too many photos — your browser\'s local storage is full.\nTry removing a few before adding more.');
    }
  }

  /* ============================================================
     二、照片的上传 / 压缩 / 预览 / 删除
     ============================================================ */

  /* 把照片列表画到页面上：预置照片在前（标"预置"、不可删），
     用户照片在后（右上角有小叉可删）。
     每次数据变化后整体重画一遍 —— 照片数量很少，简单可靠最重要 */
  function renderPhotoList() {
    photoList.innerHTML = '';

    PRESET_PHOTOS.forEach(function (fileName) {
      photoList.appendChild(buildPhotoItem('assets/photos/' + fileName, true));
    });

    userPhotos.forEach(function (dataUrl, index) {
      photoList.appendChild(buildPhotoItem(dataUrl, false, index));
    });
  }

  function buildPhotoItem(src, isPreset, index) {
    var item = document.createElement('div');
    item.className = 'photo-item';

    var img = document.createElement('img');
    img.src = src;
    img.alt = isPreset ? 'Preset photo' : 'Your photo';
    // 预置图文件不存在（比如文件夹还是空的）时，悄悄把这个格子撤掉，不打扰用户
    img.onerror = function () { item.remove(); };
    item.appendChild(img);

    if (isPreset) {
      var tag = document.createElement('span');
      tag.className = 'preset-tag';
      tag.textContent = 'Preset';
      item.appendChild(tag);
    } else {
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'photo-del';
      delBtn.textContent = '×';
      delBtn.title = 'Remove this photo';
      // 用闭包锁住 index：点哪个叉，就删哪一张
      delBtn.addEventListener('click', function () {
        userPhotos.splice(index, 1);
        saveUserPhotos();   // 删完立刻写回小仓库，刷新后也不会"复活"
        renderPhotoList();
      });
      item.appendChild(delBtn);
    }
    return item;
  }

  /* 用户选完照片（支持多选） */
  photoInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(photoInput.files || []);
    files.forEach(function (file) {
      // 防呆：万一有浏览器没按 accept 过滤，非图片直接跳过
      if (!file.type || file.type.indexOf('image/') !== 0) return;
      compressImage(file, function (dataUrl) {
        userPhotos.push(dataUrl);
        saveUserPhotos();
        renderPhotoList();
      });
    });
    // 清空选择框：否则连续两次选同一张照片，第二次不会触发 change 事件
    photoInput.value = '';
  });

  /* 压缩照片：手机原图动辄 3~5MB，直接存 localStorage 几下就爆仓。
     做法：canvas 就像一块看不见的"画板"，把原图等比缩小画上去，
     再导出成体积更小的 JPEG base64 字符串。 */
  function compressImage(file, onDone) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        // 等比缩放：最长边不超过 MAX_PHOTO_EDGE，小图不放大
        var scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        onDone(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.onerror = function () {
        console.warn('这张图片读不出来，已跳过：', file.name);
      };
      img.src = e.target.result;
    };
    reader.onerror = function () {
      console.warn('文件读取失败，已跳过：', file.name);
    };
    reader.readAsDataURL(file);
  }

  /* ============================================================
     三、姓名 / 年龄校验
     ============================================================ */

  /* 给输入框打上"出错"标记：红框常亮（改对才消失）+ 抖动一次。
     为什么红框和抖动分成两个 class？
     抖动动画播完要移除 .shake，下次点按钮才能再抖一次；
     而红框 .input-error 要一直留着，直到用户开始修改。 */
  function markInvalid(input) {
    input.classList.add('input-error');
    input.classList.remove('shake');
    void input.offsetWidth;   // 强制浏览器"喘口气"（重新渲染），动画才能从头再播
    input.classList.add('shake');
  }

  // 用户一开始打字就解除红框：知错就改，立刻给正反馈
  [nameInput, ageInput].forEach(function (input) {
    input.addEventListener('input', function () {
      input.classList.remove('input-error');
    });
  });

  /* 校验：两个框都合格才放行，返回 { name, age }；否则返回 null */
  function validateForm() {
    var name = nameInput.value.trim();
    var ageText = ageInput.value.trim();
    // 用 Number 而不是 parseInt：parseInt('2.5') 会得到 2，把小数年龄误判为合法；
    // Number('2.5')=2.5 会被 Number.isInteger 拦下，Number('abc')=NaN 做任何比较都是 false
    var age = Number(ageText);

    var nameOk = name.length > 0;
    var ageOk = ageText !== '' && Number.isInteger(age) && age >= 1 && age <= 150;

    if (!nameOk) markInvalid(nameInput);
    if (!ageOk) markInvalid(ageInput);
    if (!nameOk || !ageOk) {
      (nameOk ? ageInput : nameInput).focus();  // 光标跳到第一个有问题的框
      return null;
    }
    return { name: name, age: age };
  }

  /* ============================================================
     四、摄像头授权流程 → 进入魔法世界
     ============================================================ */

  enterBtn.addEventListener('click', function () {
    var result = validateForm();
    if (!result) return;  // 校验不过：红框抖动提示，停在这里

    // 请求摄像头期间禁用按钮，防止心急连点造成重复弹窗
    enterBtn.disabled = true;
    enterBtn.textContent = 'Requesting camera…';

    // 老浏览器没有摄像头 API：不算失败，直接给降级入口
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      restoreEnterBtn();
      cameraDenied.classList.remove('hidden');
      return;
    }

    navigator.mediaDevices.getUserMedia({ video: true })
      .then(function (stream) {
        // 授权成功：带着视频流进入魔法世界
        enterWorld(result.name, result.age, stream);
      })
      .catch(function (err) {
        // 用户点了"拒绝"、或机器没有摄像头：亮出 Plan B 入口
        console.warn('摄像头不可用（可改走手动按钮模式）：', err && err.name);
        restoreEnterBtn();
        cameraDenied.classList.remove('hidden');
      });
  });

  function restoreEnterBtn() {
    enterBtn.disabled = false;
    enterBtn.textContent = 'Begin';
  }

  /* "跳过手势，直接看蛋糕"：没有摄像头也能玩，
     cameraStream 传 null，进入后显示手动按钮区（降级模式） */
  skipCameraBtn.addEventListener('click', function () {
    var result = validateForm();   // 再校验一次，防止等弹窗期间用户把名字清空了
    if (!result) return;
    enterWorld(result.name, result.age, null);
  });

  /* 共同出口：藏起录入页，亮出 3D 场景，并把入场资料交给蛋糕场景 */
  function enterWorld(name, age, cameraStream) {
    introScreen.classList.add('hidden');
    sceneContainer.classList.remove('hidden');

    if (cameraStream) {
      // 把摄像头画面接到右下角的小窗上
      camPreview.srcObject = cameraStream;
      var playPromise = camPreview.play();
      // play() 返回 Promise：个别浏览器自动播放策略会拒绝，兜住它，不影响主流程
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () { /* 画面晚一点出来也没关系 */ });
      }
      camPreview.classList.remove('hidden');
    } else {
      // 降级模式：显示"✋ 炸开蛋糕 / ✊ 恢复原样"手动按钮
      gestureFallback.classList.remove('hidden');
    }

    /* 把入场资料打包交给 3D 蛋糕场景。
       window.startCakeScene 由后续任务实现；现在它还不存在，
       所以先判断"有没有这个函数"再调用，没有就在控制台留个言占位。 */
    var payload = {
      name: name,
      age: age,
      photos: collectAllPhotos(),
      cameraStream: cameraStream
    };
    if (typeof window.startCakeScene === 'function') {
      window.startCakeScene(payload);
    } else {
      console.warn('window.startCakeScene 尚未实现（3D 蛋糕场景将在后续任务中完成）。本次入场参数：', {
        name: name,
        age: age,
        照片数量: payload.photos.length,
        摄像头: cameraStream ? '已授权' : '无（降级模式）'
      });
    }
  }

  /* 汇总所有照片：预置照片路径在前，用户上传的 base64 在后。
     两种都是"图片地址"，后续 3D 场景可以统一当贴图加载 */
  function collectAllPhotos() {
    var presetSrcs = PRESET_PHOTOS.map(function (fileName) {
      return 'assets/photos/' + fileName;
    });
    return presetSrcs.concat(userPhotos);
  }

  /* ============================================================
     五、降级模式按钮：✋ 炸开蛋糕 / ✊ 恢复原样（来回切换）
     ============================================================ */
  var exploded = false;
  explodeToggle.addEventListener('click', function () {
    exploded = !exploded;
    explodeToggle.textContent = exploded ? '✊ Put it back' : '✋ Open the cake';
    // 动画函数同样由后续任务实现：有就调用，没有就留话
    if (typeof window.toggleCakeExplode === 'function') {
      window.toggleCakeExplode(exploded);
    } else {
      console.warn('window.toggleCakeExplode 尚未实现（炸开/恢复动画将在后续任务中完成）。当前状态：' + (exploded ? '炸开' : '恢复'));
    }
  });

  /* ============================================================
     六、页面加载：把照片列表画出来
     ============================================================ */
  renderPhotoList();
})();
