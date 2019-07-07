const fs = require('fs')
const path = require('path')
const fetch = require('node-fetch')
const crypto = require('crypto')

class SimpleFileStorageKey {
	constructor(path) {
		this.path = path;
		this.jsonSpace = "  ";
	}
	get(def) {
		try {
			return JSON.parse(fs.readFileSync(this.path, "utf8"));
		} catch(e) {
			return def;
		}
	}
	set(value) {
		fs.writeFileSync(this.path, JSON.stringify(value, "", this.jsonSpace), "utf8");
	}
	update(callback, def) {
		this.set(callback(this.get(def)));
	}
}
class SimpleFileStorage {
	constructor(section, options) {
		this.options = {
			dir: "./", 
			...options
		};
		this.pathStart = path.join(__dirname, this.options.dir, `_${section}_`);
	}
	key(key) {
		return new SimpleFileStorageKey(`${this.pathStart}${key}.json`);
	}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class OnceInTimeInterval {
	constructor(timeInterval, firstWait = true) {
		this.timeInterval = timeInterval;
		this.lastTime = firstWait ? 0 : Date.now();
	}
	
	check(next = true) {
		const fl = Date.now() >= this.lastTime + this.timeInterval;
		if ( fl && next )
			this.lastTime = Date.now();
		return fl;
	}
	
	wrap(callback) {
		if ( this.check(true) )
			callback();
	}
}

class QueueItem {
	constructor(args, parentId = null, id = null, done = false) {
		this.id = id ? id : crypto.randomBytes(8).toString("hex");
		this.parentId = parentId;
		this.args = args;
		this.done = done;

		this.errors = [];
	}

	static fromRaw(raw) {
		return new this(raw.args, raw.parentId, raw.id, raw.done);
	}
}
class QueueItemContext {
	constructor() {
		this.array = [];
	}
	
	push(...args) {
		this.array.push(["push", ...args]);
	}
	pushOnce(...args) {
		this.array.push(["pushOnce", ...args]);
	}
	
	forEach(callback) {
		this.array.forEach(callback);
	}
}
class QueueLoad {
	constructor(options) {
		this.options = {
			sfsk: new SimpleFileStorage("QueueLoad").key("Queue"),
			maxThreads: 1,
			saveQueueMinTimeInterval: 60*1e3,	/// 1 min
			...options
		};
		
		this.names = {};
		this.once = new Set();
		this.queue = [];
		this.errors = [];
		this.numThreads = 0;
		
		this.work = false;
		
		this.maxThreads = this.options.maxThreads;
		
		this.sfsk = this.options.sfsk;
		
		this.next = 0;
		
		this.oitiSave = new OnceInTimeInterval(this.options.saveQueueMinTimeInterval);
		
		this.loadQueue();
	}

	isContinue() {
		return this.sfsk.get(undefined) !== undefined;
	}
	
	reg(key, callback) {
		this.names[key] = callback;
	}
	push(queueItem, ...args) {
		this.queue.push(new QueueItem(args, queueItem.id));
	}
	pushOnce(queueItem, ...args) {
		const key = JSON.stringify(args);
		if ( this.once.has(key) )
			return;

		this.once.add(key);
		this.push(queueItem, ...args);
	}

	async doQueueItem(queueItem) {
		const fun = this.names[queueItem.args[0]];
		if ( !fun ) {
			this.pushError(new Error(`Name '${queueItem.args[0]}' not found`));
			return false;
		}
		
		try {
			const ctx = new QueueItemContext();
			await fun(ctx, ...queueItem.args.slice(1));
			ctx.forEach(([prop, ...args]) =>
				this[prop](queueItem, ...args) );
			
			queueItem.done = true;
			return true;
		} catch(e) {
			queueItem.errors.push(e.message);
			queueItem.done = false;
			this.pushError(e);
		}
		
		return false;
	}
	async doQueueItems(numErrors = 0) {
		const queueItemArray = [];
		
		for(const queueItem of this.queue) {
			if ( queueItemArray.length >= this.maxThreads )
				break;

			if ( queueItem.done )
				continue;
			
			if ( queueItem.errors.length > numErrors )
				continue;

			queueItemArray.push(queueItem);
		}
		
		await Promise.all( queueItemArray.map(this.doQueueItem.bind(this)) );
		
		for(const queueItem of queueItemArray) {
			if ( !queueItem.done ) {
				let i = this.queue.indexOf(queueItem);
				this.queue.splice(i, 1);
				this.queue.push(queueItem);
			}
		}

		this.oitiSave.wrap(this.saveQueue.bind(this));
		
		return queueItemArray.length;
	}
	
	async start() {
		this.work = true;
		
		while( this.work && await this.doQueueItems(0) ) {}
		
		while( this.work && await this.doQueueItems(5) ) {}
		
		this.saveQueue();
	}
	async stop() {
		this.work = false;
	}

	loadQueue() {
		this.queue = [];
		const {queue, once, errors} = this.sfsk.get({ once: [], queue: [], errors: [] });
		for(const raw of queue) {
			this.queue.push(QueueItem.fromRaw(raw));
		}
		this.once = new Set(once);
		this.errors = errors;
	}
	saveQueue() {
		console.time("saveQueue");
		this.sfsk.set({
			queue: this.queue,
			once: [...this.once],
			errors: this.errors,
		});
		console.timeEnd("saveQueue");
	}
	
	pushError(error) {
		console.log("Error: %s", error.message);
		this.errors.push(`[${ new Date().toISOString() }] ${error.message}`);
	}
}


class SaveAnswerClues {
	constructor(options) {
		this.options = {
			dir: "./crosswordAnswers",
			...options
		};
		
		this.dirAbs = path.join(__dirname, this.options.dir);
		this.dirOnceAbs = path.join(this.dirAbs, "./once");
		try {
			fs.mkdirSync(this.dirAbs, {recursive: true});
			fs.mkdirSync(this.dirOnceAbs, {recursive: true});
		} catch(e) {}
	}
	
	_wrapFileName(name, prefix = "_") {
		return prefix + Buffer.from(name, "utf8").toString("hex")
	}
	
	addAnswer(answer, clues) {
		const filePath = path.join(this.dirAbs, this._wrapFileName(answer)) + ".json";
		
		let obj;
		try {
			obj = JSON.parse(fs.readFileSync(filePath))
			obj.answer = answer;
			obj.clues = [...new Set([...obj.clues, ...clues])];
		} catch(e) {
			obj = {answer, clues};
		}
		
		try {
			fs.writeFileSync(filePath, JSON.stringify(obj, "", "  "));
		} catch(e) {}
	}
	parseRawCollectClues(word, text) {
		const clues = text.match(/(?<=crossword-clue">)[\w\s]+(?=<)/g) || [];
	
		this.addAnswer(word, clues);
	}
	
	checkOnce(obj) {
		const pathAbs = path.join(this.dirOnceAbs,
			this._wrapFileName(JSON.stringify(obj), "_ONCE_") );
		const fl = fs.existsSync(pathAbs);
		if ( !fl )
			fs.writeFileSync(pathAbs, "");
		return !fl;
	}
	wrapOnce(obj, callback) {
		if ( this.checkOnce(obj) )
			callback();
	}
}


const queueLoad = new QueueLoad({
	sfsk: new SimpleFileStorage("Tmp").key("queue"),
	
	maxThreads: 200,
	saveQueueMinTimeInterval: 10*60*1e3, // 10 min
});

const sac = new SaveAnswerClues({
	dir: "./crosswordAnswers",
});





queueLoad.reg("init", async (queueLoad) => {
	const url = `https://www.freecrosswordsolver.com/sitemap-answers.xml`
	const text = await (await fetch(url)).text()

	const urls = text.match(/https:\/\/www\.freecrosswordsolver\.com\/sitemap-answers-\d+\.xml/g) ||[];
	for(const url of urls)
		queueLoad.pushOnce("answerLoad", url);
});
queueLoad.reg("answerLoad", async (queueLoad, url) => {
	console.log("answerLoad: %s", url);
	const text = await (await fetch(url)).text();
	let words = text.match(/(?<=answer\/)\w+(?=<)/g) || [];

	for(const word of words)
		queueLoad.pushOnce("collectClues", word)
});
queueLoad.reg("collectClues", async (queueLoad, word) => {
	const clues = []
	const url = `https://www.freecrosswordsolver.com/answer/${word}`
	
	console.log("collectClues: %s", url)
	const text = await (await fetch(url)).text()
	const re = new RegExp(
		`(?<=<a class="page-link" href="https:\/\/www\\.freecrosswordsolver\\.com\/answer\/${word}\\?page=)\\d+(?=">)`,
		'g',
	)
	
	sac.parseRawCollectClues(word, text);

	const pages = text.match(re) || [];
	for(const page of pages)
		queueLoad.pushOnce("collectCluesOther", word, page)
});
queueLoad.reg("collectCluesOther", async (queueLoad, word, page) => {
	const url = `https://www.freecrosswordsolver.com/answer/${word}?page=${page}`

	console.log("collectCluesOther: %s", url)
	const text = await (await fetch(url)).text();
	sac.parseRawCollectClues(word, text);
});

(async () => {
	if ( !queueLoad.isContinue() ) {
		console.log("Init")
		queueLoad.push({id: null}, "init");
	}
	
	console.time("TimeLoad");
	await queueLoad.start();
	console.timeEnd("TimeLoad");

})();

