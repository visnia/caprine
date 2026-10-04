(() => {
	const target = __TARGET__;
	const reason = __REASON__;
	let remaining = __DELAY__;
	document.title = 'caprine — offline';
	document.documentElement.innerHTML = '<head><meta charset="utf-8"><style>'
		+ ':root{color-scheme:light dark;font:15px system-ui,sans-serif}body{margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}'
		+ 'main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{opacity:.8}button{font:inherit;padding:.5rem 1.2rem;border-radius:999px;border:0;background:#0866ff;color:#fff;cursor:pointer}'
		+ '</style></head><body><main><h1>Messenger is unreachable</h1><p id="detail"></p><p id="countdown"></p><button id="retry" type="button">Retry now</button></main></body>';
	document.getElementById('detail').textContent = `caprine retries automatically. Last error: ${reason}`;
	const countdown = document.getElementById('countdown');
	const tick = () => {
		countdown.textContent = remaining > 0 ? `Attempt __ATTEMPT__ failed. Next attempt in ${remaining} s.` : 'Retrying…';
		remaining -= 1;
	};
	tick();
	setInterval(tick, 1000);
	document.getElementById('retry').addEventListener('click', () => location.replace(target));
})();
