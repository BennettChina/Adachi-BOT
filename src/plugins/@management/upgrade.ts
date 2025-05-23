import fetch, { Response } from "node-fetch";
import pm2 from "pm2";
import { defineDirective, InputParameter } from "@/modules/command";
import { execCommand } from "@/utils/system";
import { waitWithTimeout } from "@/utils/async";
import process from "process";


/* 检查更新 */
async function getCommitsInfo(): Promise<any[]> {
	const result: Response = await fetch( "https://api.github.com/repos/SilveryStar/Adachi-BOT/commits" );
	return await result.json();
}

/* 更新 bot */
async function updateBot( { matchResult, sendMessage, logger, config }: InputParameter<"order"> ): Promise<void> {
	const isForce = !!matchResult.match[0];
	let command = !isForce ? "git checkout HEAD package*.json && git pull --no-rebase" : "git reset --hard && git pull --no-rebase";
	const proxy_env = {};
	if ( config.base.proxy.enabled ) {
		proxy_env["http_proxy"] = config.base.proxy.httpProxy;
		proxy_env["https_proxy"] = config.base.proxy.httpsProxy;
		proxy_env["all_proxy"] = config.base.proxy.sockets5Proxy;
		proxy_env["no_proxy"] = ''
	}
	let execPromise = execCommand( command, {
		env: {
			...process.env,
			...proxy_env
		},
	} ).then( ( stdout: string ) => {
		logger.info( stdout );
		if ( /(Already up[ -]to[ -]date|已经是最新的)/.test( stdout ) ) {
			throw "当前已经是最新版本了";
		}
	} );
	
	try {
		await waitWithTimeout( execPromise, 30000 );
	} catch ( error ) {
		if ( typeof error === "string" ) {
			const errMsg = error.includes( "timeout" ) ? "更新失败，网络请求超时" : error;
			await sendMessage( errMsg );
		} else {
			await sendMessage( `更新失败，可能是网络出现问题${ !isForce ? "或存在代码冲突，若不需要保留改动代码可以追加 -f 使用强制更新" : "" }` );
		}
		logger.error( `更新 BOT 失败: ${ typeof error === "string" ? error : ( <Error>error ).message }` );
		throw error;
	}
	
	try {
		command = "pnpm i -P --no-frozen-lockfile";
		execPromise = execCommand( command, {
			env: {
				...process.env,
				"CI": "1"
			}
		} ).then( ( stdout: string ) => {
			logger.info( stdout );
		} );
		await waitWithTimeout( execPromise, 60000 );
	} catch ( error ) {
		if ( typeof error === "string" ) {
			const errMsg = error.includes( "timeout" ) ? "更新成功，依赖安装超时" : error;
			await sendMessage( errMsg );
		} else {
			await sendMessage( "依赖安装失败，请前往控制台查看错误信息。" );
		}
		logger.error( `依赖安装失败: ${ typeof error === "string" ? error : ( <Error>error ).message }` );
		throw error;
	}
	
	await sendMessage( "更新成功，BOT 正在自行重启，请稍后" );
	
	pm2.restart( "adachi-bot", async ( error ) => {
		logger.error( error );
		await sendMessage( `重启 BOT 出错: ${ error }` );
		throw error;
	} );
}

export default defineDirective( "order", async ( i ) => {
	const dbKey: string = "adachi.update-time";
	
	let commits: any[] = []
	try {
		commits = await getCommitsInfo();
	} catch ( error ) {
		i.logger.error( error );
		await i.sendMessage( "检查更新出错，可能是网络波动，请重试" );
		return;
	}
	
	const newDate: string = commits[0].commit?.committer?.date;
	const oldDate: string = await i.redis.getString( dbKey );
	
	if ( !oldDate ) {
		await i.sendMessage( "初次使用该指令，将直接尝试更新 BOT" );
		try {
			await updateBot( i );
		} catch ( error ) {
			return;
		}
		await i.redis.setString( dbKey, newDate );
		return;
	}
	
	const commitsNew = commits.filter( e => {
		const commitDate: Date = new Date( e.commit?.committer?.date );
		return Number( commitDate ) - Number( new Date( oldDate ) ) > 0;
	} );
	
	if ( commitsNew.length === 0 ) {
		await i.sendMessage( "当前已经是最新版本了" );
		return;
	}
	
	await i.sendMessage( "开始尝试更新 BOT..." );
	
	try {
		await updateBot( i );
	} catch ( error ) {
		return;
	}
	await i.redis.setString( dbKey, newDate );
} );