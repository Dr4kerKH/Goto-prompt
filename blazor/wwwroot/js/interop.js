function initDotGrid() {
    const canvas = document.getElementById('dot-grid');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const spacing = 28;
    let mouse = { x: -1000, y: -1000 };
    let animFrame;

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let x = 0; x < canvas.width; x += spacing) {
            for (let y = 0; y < canvas.height; y += spacing) {
                const dist = Math.hypot(x - mouse.x, y - mouse.y);
                const glow = Math.max(0, 1 - dist / 200);
                const alpha = 0.12 + glow * 0.55;
                const size = 1 + glow * 2;
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(99, 102, 241, ${alpha})`;
                ctx.fill();
            }
        }
        animFrame = requestAnimationFrame(draw);
    }

    window.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
    window.addEventListener('resize', resize);
    resize();
    draw();

    // expose cleanup for Blazor component dispose
    window._dotGridCleanup = () => {
        cancelAnimationFrame(animFrame);
        window.removeEventListener('resize', resize);
    };
}

function scrollToBottom(elementId) {
    const el = document.getElementById(elementId);
    if (el) el.scrollTop = el.scrollHeight;
}
