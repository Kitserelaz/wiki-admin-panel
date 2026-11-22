export function bytes(value: number | null | undefined) {
	if (value == null || !Number.isFinite(value)) return 'Unavailable';
	const scale = value > 0 ? Math.max(0, Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))) : 0;
	return `${(value / 1024 ** scale).toFixed(scale ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][scale]}`;
}
export function percent(value: number | null | undefined) {
	return value == null ? 'Unavailable' : `${value.toFixed(1)}%`;
}
export function duration(seconds: number | null | undefined) {
	if (seconds == null) return 'Unavailable';
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor(seconds % 86400 / 3600);
	const minutes = Math.floor(seconds % 3600 / 60);
	return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
export function time(timestamp: number | null | undefined) {
	return timestamp == null ? 'Awaiting collection' : new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
