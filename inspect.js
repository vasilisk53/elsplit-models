// Осмотр ножа в окне магазина: руки + нож CS2 в 3D (three.js), анимации из игры.
// open(el, {knife: url, arms: url}, opts) -> {play(name), view(mode), pose(name, t), dispose()}
// Нож (меш + скелет рук + все анимации) и руки (меши перчаток) - отдельные GLB: руки общие для всех ножей
// и цепляются к скелету ножа по именам костей.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Камера вьюмодели CS2: вертикальный FOV 60, смещение модели (вперёд 1, влево 1, вниз 1) - как в нашей сборке ножей
const VM_FOV = 60, VM_OFF = { fwd: 1, left: 1, up: -1 };
const FADE = 0.2;                       // кроссфейд между анимациями, как в графе ножа CS2
const DRACO = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

let loader = null;
function getLoader() {
    if (!loader) {
        const d = new DRACOLoader();
        d.setDecoderPath(DRACO);
        loader = new GLTFLoader();
        loader.setDRACOLoader(d);
    }
    return loader;
}

function load(url, onProgress) {
    return new Promise((res, rej) => getLoader().load(url, res, onProgress, rej));
}

// Скин-меши рук перевешиваем на кости ножа с теми же именами (обратные bind-матрицы - свои, из файла рук)
function attachArms(armsScene, knifeRoot) {
    const bones = {};
    knifeRoot.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    const meshes = [];
    armsScene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    for (const m of meshes) {
        const sk = m.skeleton, list = [], inv = [];
        for (let i = 0; i < sk.bones.length; i++) {
            const b = bones[sk.bones[i].name];      // служебных костей ножа T в скелете ножа нет - на них ничего не висит
            list.push(b || sk.bones[i]);
            inv.push(sk.boneInverses[i].clone());
        }
        m.removeFromParent();
        knifeRoot.add(m);
        m.bind(new THREE.Skeleton(list, inv), new THREE.Matrix4());
        m.frustumCulled = false;
    }
}

export function open(el, urls, opts) {
    opts = opts || {};
    const W = () => el.clientWidth || 1, H = () => el.clientHeight || 1;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W(), H());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 1.6;    // отражения на металле ножа
    const key = new THREE.DirectionalLight(0xfff2e0, 2.6);    // тёплый ключевой свет сверху
    key.position.set(4, 6, -2);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 1.4);    // холодный контровой сзади
    rim.position.set(-5, 2, 8);
    scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.35));

    const camera = new THREE.PerspectiveCamera(VM_FOV, W() / H(), 0.5, 500);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.enabled = false;

    const clock = new THREE.Clock();
    let mixer = null, actions = {}, cur = null, root = null, alive = true, onEnd = null;

    // Вид от первого лица: глаз в начале координат. После импорта SMD и экспорта в glTF
    // вперёд = +Z, вверх = +Y, влево = +X (камера смотрит вдоль +Z, поэтому +X на экране слева).
    function fpView() {
        controls.enabled = false;
        camera.fov = VM_FOV;
        camera.position.set(0, 0, 0);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 0, 1);
        camera.updateProjectionMatrix();
    }
    // Витрина (для окна магазина): камера вьюмодели, сдвинутая и повёрнутая так, чтобы руки с ножом смотрелись лучше.
    // SHOW = [FOV, вправо, вниз, вперёд, поворот вправо (град), наклон вниз (град)]; opts.show / setShow()
    // своя камера у каждого ножа - cameras.json (выставлены в tuner.html); это - запасная, если ножа там нет
    let SHOW = opts.show || [65, -3, 0, 0, 5, 3];
    function showView() {
        controls.enabled = false;
        const [fov, right, down, fwd, yawD, pitchD] = SHOW.concat([0, 0, 0, 0, 0, 0]).slice(0, 6);
        const yaw = yawD * Math.PI / 180, pitch = pitchD * Math.PI / 180;
        camera.fov = fov;
        camera.position.set(-right, -down, fwd);
        camera.up.set(0, 1, 0);
        camera.lookAt(-right - Math.sin(yaw) * Math.cos(pitch), -down - Math.sin(pitch), fwd + Math.cos(yaw) * Math.cos(pitch));
        camera.updateProjectionMatrix();
    }
    // Свободная камера: крутим вокруг рук и ножа
    function orbitView() {
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root, true), c = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        camera.fov = 40;
        camera.position.set(c.x - size * 0.2, c.y + size * 0.25, c.z - size * 0.9);
        controls.target.copy(c);
        controls.enabled = true;
        camera.updateProjectionMatrix();
        controls.update();
    }

    function play(name, loop) {
        const a = actions[name];
        if (!a) return false;
        a.reset();
        a.paused = false;
        a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        a.clampWhenFinished = true;
        if (cur && cur !== a) a.crossFadeFrom(cur, FADE, false);
        a.play();
        cur = a;
        return true;
    }

    // Прогресс двух файлов складываем по байтам
    const got = { k: 0, a: 0 }, tot = { k: 0, a: 0 };
    const prog = (key) => (p) => {
        got[key] = p.loaded; tot[key] = p.total || 0;
        if (opts.onProgress && tot.k) opts.onProgress(Math.min(1, (got.k + got.a) / (tot.k + (urls.arms ? tot.a || 400000 : 0))));
    };

    Promise.all([load(urls.knife, prog('k')), urls.arms ? load(urls.arms, prog('a')) : null]).then(([g, a]) => {
        if (!alive) return;
        root = g.scene;
        root.position.set(VM_OFF.left, VM_OFF.up, VM_OFF.fwd);
        if (a) attachArms(a.scene, root);
        root.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
        scene.add(root);
        mixer = new THREE.AnimationMixer(root);
        g.animations.forEach((c) => { actions[c.name] = mixer.clipAction(c); });
        mixer.addEventListener('finished', (e) => {
            if (e.action === cur && cur !== actions.idle) { play('idle', true); if (onEnd) onEnd(e.action.getClip().name); }
        });
        (opts.view === 'fp' ? fpView : showView)();
        play(actions.draw ? 'draw' : 'idle', !actions.draw);
        if (opts.onLoad) opts.onLoad(Object.keys(actions));
    }).catch((err) => { if (opts.onError) opts.onError(err); });

    function frame() {
        if (!alive) return;
        requestAnimationFrame(frame);
        const dt = Math.min(clock.getDelta(), 0.1);
        if (mixer) mixer.update(dt);
        if (controls.enabled) controls.update();
        renderer.render(scene, camera);
    }
    frame();

    const ro = new ResizeObserver(() => {
        renderer.setSize(W(), H());
        camera.aspect = W() / H();
        camera.updateProjectionMatrix();
    });
    ro.observe(el);

    return {
        play: (n) => play(n, false),
        has: (n) => !!actions[n],
        setShow: (v) => { SHOW = v; if (root && !controls.enabled) showView(); },
        // габариты модели в текущей позе (для проверки сборки): [ширина, высота, глубина]
        bounds: () => { if (!root) return null; root.updateMatrixWorld(true); const v = new THREE.Box3().setFromObject(root, true).getSize(new THREE.Vector3()); return [v.x, v.y, v.z].map((x) => Math.round(x)); },
        view: (m) => { if (root) (m === 'orbit' ? orbitView : m === 'fp' ? fpView : showView)(); },
        onEnd: (f) => { onEnd = f; },
        // кадр анимации на момент t (превью/скриншоты): останавливает микшер на этой позе
        pose: (n, t) => {
            const x = actions[n];
            if (!x || !mixer) return false;
            mixer.stopAllAction(); x.reset().play(); x.paused = true; x.time = t; mixer.update(0); cur = x;
            return x.getClip().duration;
        },
        dispose: () => {
            alive = false;
            ro.disconnect();
            controls.dispose();
            scene.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) [].concat(o.material).forEach((m) => { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); });
            });
            pmrem.dispose();
            renderer.dispose();
            el.innerHTML = '';
        }
    };
}
