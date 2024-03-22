const {launch, EventEmitter} = require("puppeteer");
const yargs = require("yargs")
const {PuppeteerScreenRecorder} = require('puppeteer-screen-recorder');
const puppeteer = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg")
const fs = require("fs")
const open = require('opener')


const argv = yargs(process.argv.slice(2))
    .option("reverse", {
        alias: 'r',
        describe: 'reverse',
        type: 'boolean',
        default: false,
    }).argv;
const {reverse} = argv
let [src, turnArg] = argv._


let turnData = (() => {
    let match = RegExp('(?<start>\\d+)(?<step1>\\|[^|]*\\|)?(?<to>-(?<end>\\d+)?(?<step2>\\|[^|]+\\|)?)?')
        .exec(turnArg);
    if (!match) return {};
    console.log(match.groups)
    let {start, step1, end, step2, to} = match.groups;
    start = parseInt(start)
    return {
        start,
        end: parseInt(end || (to ? (step2 ? start : 0) : start + 1)),
        step1, step2
    }
})();

console.log(turnData)

const PREFIX = 'https://replay.pokemonshowdown.com/';
if (!src.startsWith(PREFIX)) src = PREFIX + src

const browser = launch({headless: false});
let usedFirstPage = false
download(browser, src, turnData)
    .then(process.exit)

async function download(browser, src, turnData) {
    browser = await browser
    /// get page to work with
    const page = await (async () => {
        if (!usedFirstPage) {
            let pages = await browser.pages();
            if (pages[0]) return pages[0];
        }
        return browser.newPage()
    })();

    const log = new Promise(resolve => {
        browser.newPage()
            .then(page => page
                .goto(`${src}.log`)
                .then(it => it.text())
                .then(text => {
                    page.close() // I don't care when it closes.
                    resolve(text)
                })
            )
    })
    await Promise.all([
        ['font-awesome', 'battle', 'replay', 'utilichart',]
            .map(url => page.addStyleTag({url: `https://play.pokemonshowdown.com/style/${url}.css?a7`})),
        [
            'js/lib/ps-polyfill.js',
            'config/config.js?a7',
            'js/lib/jquery-1.11.0.min.js',
            'js/lib/html-sanitizer-minified.js',
            'js/battle-sound.js',
            'js/battledata.js?a7',
            'data/pokedex-mini.js?a7',
            'data/pokedex-mini-bw.js?a7',
            'data/graphics.js?a7',
            'data/pokedex.js?a7',
            'data/moves.js?a7',
            'data/abilities.js?a7',
            'data/items.js?a7',
            'data/teambuilder-tables.js?a7',
            'js/battle-tooltips.js?a7',
            'js/battle.js?a7'
        ].map(url => page.addScriptTag({url: `https://play.pokemonshowdown.com/${url}`})),
    ].flat())
    const Battle = await page.evaluateHandle("Battle")
    const wrapper = await page.evaluateHandle(() => {
        // set up
        let el = $('.wrapper');
        if (el.length) return el;
        $('body').append(
            '<div class="wrapper replay-wrapper">'
            + '<div class="battle"></div>'
            + '<div class="battle-log"></div>'
            // + '<div class="replay-controls"></div>'
            // + '<div class="replay-controls-2"></div>'
        );
        return $('.wrapper');
    })

    let battle = await Battle.evaluateHandle((Battle, text) => new Battle({
        id: $('input[name=replayid]').val() || '',
        $frame: $('.battle'),
        $logFrame: $('.battle-log'),
        log: (text || '').replace(/\\\//g, '/').split('\n'),
        isReplay: true,
        paused: true,
        autoresize: false,
    }), await log)
    if (reverse) {
        await battle.evaluate(b => b.switchViewpoint())
    }
    let state = new EventEmitter()
        .on('turn', async () => {
            const {end} = turnData
            if (!end) return
            const turn = await page.evaluate(b => b.turn, battle);
            if (turn >= end) {
                const {step2} = turnData
                if (step2) {
                    // search for end action
                    let step = null
                    const newStep = async () => {
                        let prev
                        while (true) {
                            prev = step
                            step = await battle.evaluate(b => b.stepQueue[b.currentStep])
                            if (prev !== step) {
                                console.log(step)
                                return step;
                            }
                        }
                    }
                    console.log('ending: ');
                    // noinspection StatementWithEmptyBodyJS
                    do await newStep(); while (!step.startsWith(step2))
                    do await newStep(); while (step === '|')
                }
                state.emit('ended');
            }
        })
    await page.exposeFunction('sub', (type, ...args) => {
        console.log(type)
        state.emit(type, args)
    })
// options
    await page.evaluate((b) => {
        b.subscribe(window.sub)
        b.ignoreNicks = true
        b.scene.updateAcceleration()
    }, battle)

    const innerbattle = await page.waitForSelector('.innerbattle');
    const crop = await Promise.all(
        Array.of(
            Promise.resolve(innerbattle),
            ...['.leftbar', '.rightbar'].map((bar,) => innerbattle.$(bar))
        ).map((i,) => i.then(e => e.boundingBox()))
    ).then(([box, l, r]) => {
        box.x = l.x + l.width
        box.width -= l.width + r.width
        return box
    })

    let file = 'test'

    await new Promise(async (resolve) => {
        const {start, step1} = turnData
        if (start) {
            await battle.evaluate((b, start) => b.seekTurn(start, true), start)
        }
        await new Promise(resolve => setTimeout(resolve, 100)) // fixme figure out a good way to determine if things are loaded
        await battle.evaluate(b => b.play())
        if (step1) {
            console.log(step1)
            let step = null;
            let lastStep;
            do {
                lastStep = step;
                step = await battle.evaluate(b => b.stepQueue[b.currentStep])
                if (lastStep !== step) console.log(step)
            } while (!step.startsWith(step1))
            // wait for the message to go away
            const getMsg = () => page.$$eval('*[class="messagebar message"]', els => els.map(e => e.textContent))
            let msg = String(await getMsg());
            console.log(msg);
            let newmsg;
            do newmsg = String(await getMsg()); while (newmsg === msg)
            console.log(newmsg)
        }
        resolve()
    })
    let recorder = await page.screencast({path: `${file}.webm`, crop})
    if (turnData && turnData.start === turnData.end) state.emit('turn')

// now to get it to actually stop when I want, lol.

    await new Promise(resolve => state.once('ended', resolve))
    await recorder.stop()
    await Promise.all([
        fixwebm(`${file}.webm`),
        page.close()
    ])
}

async function fixwebm(file) {
    return new Promise((resolve, reject) => {
        const tmp = file + '.tmp.webm'
        const command = ffmpeg(file)
            .withVideoCodec("copy")
            .withAudioCodec("copy") // Copy the video and audio streams without re-encoding
            .output(tmp)
            .on("end", () => {
                fs.rmSync(file)
                fs.renameSync(tmp, file)
                open(file)
                makeGif(file)
                resolve()
            })
            .on("error", (err) => {
                console.error("Error fixing metadata:", err)
                reject(err)
            })

        command.run()
    })
}

async function makeGif(file) {
    // const bar = isMultiBar ? _bar.create() : _bar
    console.log('starting Gif creation')
    const [filename,] = file.split('.', 1)
    const palette = filename + '.png'
    const gif = filename + '.gif'
    const withBar = (resolve, reject, s) => s
        .on('start', (cmd) => {
            console.log(cmd)
            // bar.start(100, 0)
        })
        .on('progress', ({percent}) => {
            // bar.update(percent)
            // bar.render()
        })
        .on('end', () => {
            // bar.update(100)
            // bar.render()
            // bar.stop()
            resolve()
        })
        .on('error', reject)

    const resized = filename + '.resize.webm'
    /*return new Promise((resolve, reject) => withBar(resolve, reject,
            ffmpeg(file)
                .inputOptions('-y')
                .videoFilter([
                    "crop=1200:890:200:5",
                    "scale=600:-1",
                ])
                .save(resized)
        )
    ).then(() =>*/
    return new Promise((resolve, reject) =>
        withBar(resolve, reject, ffmpeg(file))
            .videoFilter('palettegen')
            .save(palette)
    ).then(() => new Promise((resolve, reject) => withBar(resolve, reject, ffmpeg())
            .addInput(file)
            .addInput(palette)
            .addInputOption("-filter_complex paletteuse")
            //.addInputOption("-r 10")
            //.outputFPS(15) // todo automatically determine fps by duration
            .save(gif)
        )
    )
        .catch(console.error)
        .finally(() => {
            // if(isMultiBar) _bar.remove(bar)
            fs.rmSync(palette)
            return open(gif)
        })
        .catch(() => {
        }) // do nothing

}