export function pollVisible(refresh: (signal: AbortSignal) => Promise<void>) {
	let busy = false;
	let controller: AbortController | null = null;
	async function poll() {
		if (document.hidden || busy) return;
		busy = true;
		controller = new AbortController();
		const timeout = setTimeout(() => controller?.abort(), 8000);
		try { await refresh(controller.signal); }
		finally { clearTimeout(timeout); busy = false; }
	}
	function visibility() {
		if (document.hidden) controller?.abort();
		else void poll();
	}
	const timer = setInterval(() => void poll(), 10000);
	document.addEventListener('visibilitychange', visibility);
	void poll();
	return () => { clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
}
export async function readApi<T>(path: string, signal?: AbortSignal): Promise<T> {
	const response = await fetch(path, { signal, cache: 'no-store' });
	if (response.redirected && new URL(response.url).pathname === '/login') {
		window.location.assign('/login');
		throw new Error('Sign in required');
	}
	if (!response.ok) throw new Error('Host agent unavailable. Displaying the last collected data.');
	return response.json();
}
