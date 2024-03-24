const {launch, EventEmitter} = require("puppeteer");
const yargs = require("yargs")
const {PuppeteerScreenRecorder} = require('puppeteer-screen-recorder');
const puppeteer = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg")

const path = require("path")
const fs = require("fs")
const open = require('opener')


const {reverse, gif, speed, fadespeed, show, _: [src, turnData]} = yargs(process.argv.slice(2))
    .option("reverse", {
        alias: 'r',
        describe: 'reverse',
        type: 'boolean',
        default: false,
    })
    .option('show', {choices: [false, 'teams', "chat"],})
    .option("gif", {
        describe: "generate a gif with this input",
        type: 'boolean',
        default: true,
    })
    .option("speed",
        {
            describe: 'factor to speed up output',
            default: 1,
            type: "number",
        })
    .option("fadespeed",
        {
            describe: 'how fast messages go away. Standard "fast" would be 6x',
            default: 1,
            type: "number",
        })
    .argv;


const PREFIX = 'https://replay.pokemonshowdown.com/';
const turnSpec = RegExp('(?<start>\\d+)(?<step1>\\|[^|]*\\|)?(?<to>-(?<end>\\d+)?(?<step2>\\|[^|]+\\|)?)?')

const folders = ["webm", "gifs"]
const [WEBM, GIF] = folders
let mkdir = function () {
    let res = {}
    for (let folder in folders) res[folder] = new Promise(resolve => fs.mkdir(folder, resolve))
    return res
}()

const $browser = launch({headless: false});
let usedFirstPage = false
download(!src.startsWith(PREFIX) ? PREFIX + src : src, turnData)
    .then(process.exit)

async function download(src, turnData) {

    let {start, end, step1, step2} = function () {
        let match = turnSpec.exec(turnData);
        if (!match) return {};
        console.log(match.groups)
        let {start, end, step2, to} = match.groups;
        return {
            ...match.groups,
            start: start = parseInt(start),
            end: parseInt(end || (to ? (step2 ? start : 0) : start + 1)),
        }
    }();

    let browser = await $browser // stupid typing stuff

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
        ].map(url => () => page.addScriptTag({url: `https://play.pokemonshowdown.com/${url}`}))
            // force all of them to load in order
            .reduce((i, v) => i.then(v), Promise.resolve()),
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
            if (!end) return
            const turn = await page.evaluate(b => b.turn, battle);
            if (turn < end) return;
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
                do await newStep(); while (!step.startsWith(step2))
                do await newStep(); while (step.startsWith('|-')) // accompanying minor actions should be included
            }
            state.emit('ended');
        })
    await page.exposeFunction('sub', (type, ...args) => {
        console.log(type)
        state.emit(type, args)
    })
// options
    await battle.evaluate((b, speed) => {
        b.subscribe(window.sub)
        b.ignoreNicks = true
        b.messageFadeTime = 300/speed;
        b.messageShownTime = 1;
        b.setMute(true); // we don't support sound right now
        // noinspection JSUnresolvedReference
        b.scene.updateAcceleration();
    }, fadespeed)

    let innerbattle = page.waitForSelector('.innerbattle');
    const crop =
        show === 'chat' ?
            await Promise.all(['.battle', '.battle-log']
                .map(c => page.$(c).then(i => i.boundingBox())))
                .then(([battle, log]) => ({
                    width: battle.width + log.width,
                    height: Math.max(battle.height, log.height),
                    x: battle.x,
                    y: Math.min(battle.y, log.y)
                })) :
            show === 'teams' ? await innerbattle.then(i => i.boundingBox())
                : await Promise.all(
                    Array.of(
                        Promise.resolve(innerbattle = await innerbattle),
                        ...['.leftbar', '.rightbar'].map((bar,) => innerbattle.$(bar))
                    ).map((i,) => i.then(e => e.boundingBox()))
                ).then(([box, l, r]) => {
                    box.x = l.x + l.width
                    box.width -= l.width + r.width
                    return box
                })

    let file = src.replace(PREFIX, '').replaceAll('?', '')
    if (turnData) {
        file += '_' + String(turnData)
            .replaceAll('-', '~')
            .replaceAll('|', '$')
            .replaceAll(RegExp('[$](?=~|$)', 'g'), '')
    }

    await new Promise(async (resolve) => {
        if (start) {
            await battle.evaluate((b, start) => b.seekTurn(start, true), start)
        }
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
            const msgbar = await page.$('div[class="messagebar message"]')
            const getMsg = () => msgbar.evaluate(els => els.textContent)
            let msg = String(await getMsg());
            console.log(msg);
            let newmsg;
            do newmsg = String(await getMsg()); while (newmsg === msg)
            console.log(newmsg)
        }
        resolve()
    })
    await mkdir[WEBM]; // just ensure that it's done
    let recorder = await page.screencast({
        path: (file = path.resolve(WEBM, `${file}.webm`)),
        crop, speed,
    })
    if (turnData && turnData.start === turnData.end) state.emit('turn')

// now to get it to actually stop when I want, lol.

    await new Promise(resolve => state.once('ended', resolve))
    await recorder.stop()
    await Promise.all([
        fixwebm(file).then(() => gif && makeGif(file)),
        page.close()
    ])
}

async function fixwebm(file) {
    return new Promise((resolve, reject) => {
        const tmp = file + '.tmp'
        const command = ffmpeg(file)
            .format('webm')
            .withVideoCodec("copy")
            .withAudioCodec("copy") // Copy the video and audio streams without re-encoding
            .output(tmp)
            .on("end", () => {
                fs.rmSync(file)
                fs.renameSync(tmp, file)
                open(file, resolve)
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
    await mkdir[GIF]
    console.log('starting Gif creation')
    const filename = path.basename(file, path.extname(file))
    const gif = path.join(GIF, filename + '.gif')
    const palette = file + '.png'
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

    return new Promise((resolve, reject) =>
        withBar(resolve, reject, ffmpeg(file))
            .videoFilter('palettegen')
            .save(palette)
    ).then(() => new Promise((resolve, reject) => withBar(resolve, reject, ffmpeg())
            .addInput(file)
            .addInput(palette)
            .addInputOption('-y')
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
            return new Promise(resolve => open(gif, resolve))
        })
        .catch(() => {
        }) // do nothing

}