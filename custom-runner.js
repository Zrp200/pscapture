const {launch, EventEmitter} = require("puppeteer");
const yargs = require("yargs")
const {PuppeteerScreenRecorder} = require('puppeteer-screen-recorder');
const puppeteer = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg")

const path = require("path")
const fs = require("fs")
const open = require('opener')

const turnSpec = RegExp('^(?<start>\\d+)(?<step1>\\|[^-]*)?(?<to>-(?<end>\\d+)?(?<step2>\\|.+)?)?')
const PREFIX = 'https://replay.pokemonshowdown.com/';

const folders = ["webm", "gifs"]
const [WEBM, GIF] = folders
let mkdir = function () {
    let res = {}
    for (let folder in folders) res[folder] = new Promise(resolve => fs.mkdir(folder, resolve))
    return res
}()

const $browser = launch({headless: true});

let {argv: {_: argv, bulk}} = yargs(process.argv.slice(2))
    .parserConfiguration({"unknown-options-as-args": true})
    .option('bulk', {
        alias: 'b',
        describe: "How many instances to run at once, if giving more than one argument",
        default: true
    })

// split parts into sections
const parts = function () {
    let result = [];
    let last = 0;
    for (let i = last; i <= argv.length; i++) {
        // todo find a clean way to split args
        if (i === argv.length || argv[i] === ':' || argv[i] === '\n') {
            let slice = argv.slice(last, i)
            last = i + 1
            if (!slice) continue
            const {argv: {_: [src, turnData], ...opts}} = yargs(slice)
                .option("reverse", {
                    alias: 'r',
                    describe: 'reverse',
                    type: 'boolean',
                    //default: false,
                })
                .option('show', {choices: [false, 'teams', "chat"],})
                .option("gif", {
                    describe: "generate a gif with this input",
                    type: 'boolean',
                    //default: true,
                })
                .option("speed",
                    {
                        describe: 'factor to speed up output',
                        //default: 1,
                        type: "number",
                    })
                .option("fadespeed",
                    {
                        describe: 'how fast messages go away. Standard "fast" would be 6. Speeds up output slightly.',
                        //default: 1,
                        type: "number",
                    })
            if (src && !turnData && turnSpec.test(src)) {
                if (result) {
                    // use the previous one
                    // currently this will just redo the whole thing, but in the future...maybe
                    result.push({...result.at(-1), turnData: src, ...opts})
                } else throw Error("No src provided!")
            } else result.push({src, turnData, ...opts})
        }
    }
    return result
}()

const awaitSync = promises => promises.reduce((pre, cur) => pre.then(cur), Promise.resolve())


// parallelism check
let actions = parts.map((value, index) => () => download(value, index))
let n = parts.length === 1 || (bulk || bulk === 1) && (bulk >= parts.length || bulk === true ? true : Math.ceil(parts.length / bulk));
(!n ? awaitSync(actions)
    : Promise.all(
        n === true ? actions.map(it => it()) :
            function () {
                // map into buckets, todo improve algorithm
                let res = []
                let i = 0;
                while (i < n) {
                    res.push(awaitSync(actions.slice(n * i, n * ++i)))
                }
                return res;
            }()
    )).then(() => $browser.then(b => b.close()))

async function download(
    {
        src,
        turnData,
        show = false,
        reverse = false,
        speed = 1,
        fadespeed = 1,
        gif = true
    }, id) {
    if (!src.startsWith(PREFIX)) src = PREFIX + src;
    let {start, end, step1, step2} = function () {
        let match = turnSpec.exec(turnData);
        if (!match) return {};
        let {start, end, to} = match.groups;
        start = parseInt(start)
        return {
            ...match.groups,
            start,
            end: parseInt(end || (to ? 0 : start + 1)),
        }
    }();

    let browser = await $browser // stupid typing stuff

    /// get page to work with
    const page = await browser.newPage();

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
        // force these to load in order
        awaitSync([
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
        ].map(url => () => page.addScriptTag({url: `https://play.pokemonshowdown.com/${url}`}))),
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
    async function seekEndStep() {
        // don't duplicate this logic
        let prev, step = null
        const newStep = async () => {
            while (true) {
                prev = step
                step = await battle.evaluate(b => b.stepQueue[b.currentStep])
                if (prev !== step) {
                    // todo clean up debug code. This is actually useful sometimes to get a bit more accuracy in follow-up uses of the program
                    console.log([id, step]);
                    return step;
                }
            }
        }
        const endOfTurn = () => step.startsWith('|turn') && prev != null && prev !== step
        do {
            await newStep();
            if (!step) return
            if (endOfTurn()) {
                console.log([id, `hit end of turn while looking for ${step2}`])
                if (end) return;
            }
        } while (!step.startsWith(step2))
        do await newStep(); while (!endOfTurn() && step === ('|') || step.startsWith('|-')) // accompanying minor actions should be included
    }

    const battleEnd = new Promise(resolve => {
        if (end) state.on('turn', async () => {
            const turn = await page.evaluate(b => b.turn, battle);
            console.log([id, 'turn ' + turn])
            if (turn < end) return;
            if (turn === end && step2) await seekEndStep()
            resolve();
        })
        else if (step2) state.on('record', () => resolve(seekEndStep()))
        state
            .on('ended', resolve)
            .on('atqueueend', resolve)
    })

    await page.exposeFunction('sub', (type, ...args) => {
        // turn has custom logic since 'turn' is super useless by itself
        if (state.emit(type, args) && type !== 'turn') console.log([id, type])
    })
// options
    await battle.evaluate((b, speed) => {
        b.subscribe(window.sub)
        b.ignoreNicks = true
        b.messageFadeTime = 300 / speed;
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

    // only keep the first part, this keeps private replays private

    let name = src.replace(PREFIX, '').replaceAll('?', '')
    let e = name.indexOf('-')
    // second occurrence
    if (e !== -1) e = name.indexOf('-', e + 1)
    if (e !== -1) name = name.substring(0, e)
    if (turnData) {
        name += '_' + String(turnData)
            .replaceAll('-', '~')
            .replaceAll('|', '$')
            .replaceAll(RegExp('[$](?=~|$)', 'g'), '')
    }

    if (start) {
        await battle.evaluate((b, start) => b.seekTurn(start, true), start)
    }
    if (step1) {
        while (true) {
            let thisStep = await battle.evaluate(b => b.stepQueue[b.currentStep()]);
            console.log([id, thisStep])
            if (thisStep.startsWith(step1)) break
            await battle.evaluate(b => {
                b.play() // call next step
                b.pause() // halt for processing
            })
        }
    }

    await mkdir[WEBM]; // just ensure that it's done
    let file = path.resolve(WEBM, `${name}.webm`)
    let recorder = await page.screencast({
        path: file,
        crop, speed,
    })
    recorder.pause()
    state.once('playing', () => {
        recorder.resume()
        state.emit('record')
        console.log([id, 'recording - ' + name])
    });
    await battle.evaluate(b => b.play())
    await battleEnd
    await recorder.stop()
    await Promise.all([
        fixwebm(file).then(() => {
            if (gif) {
                console.log([id, 'gif']);
                return makeGif(file);
            }
        }),
        page.close()
    ])
    console.log([id, 'complete - ' + name])
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
            .on("error", (cause) => reject(new Error("Unable to fix metadata", {cause})))

        command.run()
    })
}

async function makeGif(file, verbose=false) {
    // const bar = isMultiBar ? _bar.create() : _bar
    await mkdir[GIF]
    const filename = path.basename(file, path.extname(file))
    const gif = path.join(GIF, filename + '.gif')
    const palette = file + '.png'
    const withBar = (resolve, reject, s) => s
        .on('start', (cmd) => {
            if(verbose) console.log(cmd)
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