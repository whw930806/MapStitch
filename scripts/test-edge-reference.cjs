// Run with Node.js and @napi-rs/canvas available (locally or through NODE_PATH).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const html = fs.readFileSync(path.join(__dirname, '..', 'edit.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script); // Check syntax of the entire application script.
function extractFunction(name) {
    const start = script.indexOf(`    function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = script.indexOf('\n    }', start);
    assert.ok(end >= 0, `${name} closing brace exists`);
    return script.slice(start, end + '\n    }'.length);
}
const size = 4096, edge = 512, far = size - edge;
// Expected source rectangle followed by destination rectangle, in drawing order.
const references = {
    left:        { offset: [-1, 0], rect: [far, 0, edge, size, 0, 0, edge, size] },
    right:       { offset: [1, 0], rect: [0, 0, edge, size, far, 0, edge, size] },
    top:         { offset: [0, -1], rect: [0, far, size, edge, 0, 0, size, edge] },
    bottom:      { offset: [0, 1], rect: [0, 0, size, edge, 0, far, size, edge] },
    topLeft:     { offset: [-1, -1], rect: [far, far, edge, edge, 0, 0, edge, edge] },
    topRight:    { offset: [1, -1], rect: [0, far, edge, edge, far, 0, edge, edge] },
    bottomLeft:  { offset: [-1, 1], rect: [far, 0, edge, edge, 0, far, edge, edge] },
    bottomRight: { offset: [1, 1], rect: [0, 0, edge, edge, far, far, edge, edge] },
};
const images = {};
Object.keys(references).forEach((name, i) => {
    const canvas = createCanvas(size, size);
    const color = [30 + i * 25, 100, 200, 255];
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `rgb(${color.slice(0, 3).join(',')})`;
    ctx.fillRect(0, 0, size, size);
    images[name] = { canvas, color };
});

async function check(names, pending = [], gx = 3, gy = -2) {
    const chunks = {}, calls = [], alerts = [], downloads = [];
    for (const name of [...names, ...pending]) {
        const [dx, dy] = references[name].offset;
        chunks[`${gx + dx}_${gy + dy}`] = {
            fullImage: images[name].canvas, isPending: pending.includes(name),
        };
    }
    let output;
    const debugImage = { style: {} };
    const context = vm.createContext({
        CHUNK_SIZE: size, EDGE_WIDTH: edge, STRIDE: far, chunks, availableSlots: {},
        alert: msg => alerts.push(msg), t: key => key,
        updateUI() {}, draw() {}, fallbackCopy() {}, setTimeout() {},
        document: {
            getElementById: () => debugImage,
            createElement(tag) {
                if (tag === 'a') return { click() { downloads.push(this); } };
                assert.equal(tag, 'canvas');
                output = createCanvas(1, 1);
                const ctx = output.getContext('2d');
                const drawImage = ctx.drawImage.bind(ctx);
                ctx.drawImage = (image, ...args) => {
                    const name = Object.keys(images).find(n => images[n].canvas === image);
                    calls.push({ name, rect: args });
                    drawImage(image, ...args);
                };
                return output;
            },
        },
    });
    vm.runInContext(extractFunction('updateAvailableSlots'), context);
    context.updateAvailableSlots();
    if (names.length || pending.length) assert.ok(context.availableSlots[`${gx}_${gy}`]);
    vm.runInContext(extractFunction('downloadEdgeForAI'), context);
    context.downloadEdgeForAI(gx, gy);
    if (!names.length) {
        assert.deepEqual(alerts, ['msg_err_grid']);
        assert.equal(downloads.length, 0);
        assert.equal(chunks[`${gx}_${gy}`], undefined);
        return;
    }
    const ordered = Object.keys(references).filter(n => names.includes(n));
    assert.deepEqual(calls, ordered.map(name => ({ name, rect: references[name].rect })));
    assert.equal(alerts.length, 0);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].download, `4K_Reference_${gx}_${gy}.png`);
    assert.equal(debugImage.src, downloads[0].href);
    assert.ok(downloads[0].href.startsWith('data:image/png;base64,'));
    const decoded = await loadImage(downloads[0].href);
    assert.equal(decoded.width, size);
    assert.equal(decoded.height, size);
    const pngCanvas = createCanvas(size, size);
    pngCanvas.getContext('2d').drawImage(decoded, 0, 0);
    const pixels = pngCanvas.getContext('2d').getImageData(0, 0, size, size).data;
    // Every PNG pixel must match the last applicable reference, or be transparent.
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let expected = [0, 0, 0, 0];
            for (const name of ordered) {
                const [, , , , dx, dy, w, h] = references[name].rect;
                if (x >= dx && x < dx + w && y >= dy && y < dy + h) expected = images[name].color;
            }
            const index = (y * size + x) * 4;
            for (let c = 0; c < 4; c++) {
                if (pixels[index + c] !== expected[c]) assert.fail(`Pixel mismatch at ${x},${y}, channel ${c}`);
            }
        }
    }
    assert.equal(chunks[`${gx}_${gy}`].isPending, true);
    assert.equal(chunks[`${gx}_${gy}`].baseX, gx * far);
    assert.equal(chunks[`${gx}_${gy}`].baseY, gy * far);
}

(async () => {
    const cases = [
        ['right'], ['bottom'], ['right', 'bottom'], ['right', 'bottom', 'bottomRight'],
        ['left', 'right', 'top', 'bottom'], Object.keys(references),
        ...['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map(n => [n]),
    ];
    for (const names of cases) {
        await check(names);
        console.log(`PASS: ${names.join(' + ')}; 4096x4096 PNG, all pixels verified`);
    }
    await check(['right'], ['bottom', 'bottomRight']);
    await check([]);
    await check([], Object.keys(references));
    console.log('PASS: pending neighbors ignored; empty/pending-only grids rejected; slot and stride checks');
})().catch(error => { console.error(error); process.exitCode = 1; });
