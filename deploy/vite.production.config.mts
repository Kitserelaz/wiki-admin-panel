const source = process.env.CLOUDWIKI_BUILD_SOURCE;
const output = process.env.CLOUDWIKI_BUILD_OUTPUT;
if (!source || !output) throw new Error('Deployment build paths are required');
const { sveltekit } = await import(`${source}/node_modules/@sveltejs/kit/src/exports/vite/index.js`);
const { default: adapter } = await import('/opt/wiki-admin-panel-deployment/build-tools/node_modules/@sveltejs/adapter-node/index.js');
export default {
	root: source,
	plugins: [sveltekit({
		compilerOptions: { runes: ({ filename }: { filename: string }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true },
		adapter: adapter({ out: output })
	})]
};
