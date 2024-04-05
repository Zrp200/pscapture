const {EventEmitter} = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg")

const path = require("path")
const fs = require("fs")
const open = require('opener')

const turnSpec = RegExp('^(?<start>\\d+|start)[|]?(?<step1>(?:(?=\\|)-\\D)?[^-]+)?(?<to>-(?<end>\\d+)?[|]?(?<step2>.+)?)?')
const PREFIX = 'https://replay.pokemonshowdown.com/';

const folders = ["webm", "gifs"]
const [WEBM, GIF] = folders
let mkdir = function () {
    let res = {}
    for (let folder of folders) res[folder] = new Promise(resolve => fs.mkdir(folder, resolve))
    return res
}()

const awaitSync = promises => promises.reduce((pre, cur) => pre.then(cur), Promise.resolve())

module.exports = {download, awaitSync, turnSpec}

async function download(
    page, {
        src,
        turnData,
        show = false,
        reverse = false,
        vspeed = 1,
        speed,
        gen, hardcore,
        gif = true,
        shouldOpen = true,
        id,
        turns = true, // show turn indicator
    }) {
    if (!src.startsWith(PREFIX)) src = PREFIX + src
    let {start, end, step1, step2} = function () {
        let {start, end, to} = turnData;
        start = parseInt(start)
        return {
            ...turnData,
            start,
            end: parseInt(end || (to ? 0 : start)),
        }
    }();

    /// get page to work with
    const {log, id: battleID} = await page.goto(`${src}.json`).then(i => i.json())
    await page.setContent(`<input name="replayid" value="${battleID}" hidden="hidden"><script class="battle-log-data" type="text/plain">${log}</script><script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>`);
    if (!turns) await page.addStyleTag({content: ".turn { display: none }"})
    let battle = await page.evaluateHandle(() => Replays.battle)
    if (reverse) {
        await battle.evaluate(b => b.switchViewpoint())
    }
    if (!id) {
        let name = ''
        if (start) name += start
        if (step1) name += step1
        if (step2 || end && end !== start) {
            name += '-'
            if (end && (step2 || end !== start)) name += end
            if (step2) name += step2;
        }
        if (reverse) name += '_p2'
        if (show) name += `_show-${show}`
        if (speed) name += '_' + speed
        id = name ? `${battleID}_${name}` : battleID;
    }

    let playToEnd
    if (step2 === 'end') {
        step2 = ''
        if (end) {
            console.log([id, `warning: "end" option given but end=${end}`])
        }
        playToEnd = true
    } else {
        playToEnd = false
    }

    let state = new EventEmitter()

    async function seekEndStep() {
        console.log([id, `searching for "${step2}"`]);
        // don't duplicate this logic
        let prev = null, step = null
        const newStep = async () => {
            while (true) {
                step = await battle.evaluate(b => b.stepQueue[b.currentStep])
                if (prev !== step) {
                    // todo clean up debug code. This is actually useful sometimes to get a bit more accuracy in follow-up uses of the program
                    console.log([id, step]);
                    prev = step
                    return step = step ? step.substring(1) : null;
                }
            }
        }
        const endOfTurn = () => step.startsWith('turn') && prev != null && prev !== step
        do {
            await newStep();
            if (typeof step != 'string') return
            if (endOfTurn()) {
                console.log([id, `hit end of turn while looking for ${step2}`])
                if (end) return;
            }
        } while (!step.startsWith(step2))
        let divider = false;
        do {
            await newStep();
            if (!step) divider = true;
        } while (!endOfTurn() && !step || !divider && step.startsWith('-')) // accompanying minor actions should be included
    }

    const battleEnd = new Promise(resolve => {
        if (end) {
            state.on('turn', async () => {
                const turn = await page.evaluate(b => b.turn, battle);
                console.log([id, 'turn ' + turn])
                if (turn < end) return; // this works because the turn event is not emitted on the first turn active
                if (turn === end && step2) await seekEndStep()
                resolve();
            })
            if (step2 && end === start) state.once('record', () => state.emit('turn')) // emit for first turn if the end is expected for that turn
        }
        else if (step2) state.on('record', () => resolve(seekEndStep()))
        if (!playToEnd) state.on('ended', resolve)
        state.on('atqueueend', () => setTimeout(resolve, playToEnd && 100))
    })

    await page.exposeFunction('sub', (type, ...args) => {
        // turn has custom logic since 'turn' is super useless by itself
        if (state.emit(type, args) && type !== 'turn') console.log([id, type])
    })

    const showChat = show === 'chat'

// options
    await battle.evaluate((b, showChat, speed, gen) => {
        b.subscribe(window.sub)
        b.ignoreNicks = !showChat
        // noinspection JSUnresolvedReference
        b.setMute(true); // we don't support sound right now
        if (speed) Replays.changeSetting('speed', speed);
        if (hardcore) { // noinspection JSUnresolvedReference
            b.setHardcoreMode(true)
        }
        if (gen) {
            b.gen = gen
            // noinspection JSUnresolvedReference
            b.scene.updateGen()
        }
    }, showChat, speed, gen, hardcore)


    let battleFrame = page.waitForSelector('.battle');
    let innerbattle = battleFrame.then(b => b.waitForSelector('.innerbattle'))
    const crop =
        showChat ?
            await Promise.all([battleFrame, page.$('.battle-log')]
                .map(c => c.then(i => i.boundingBox())))
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

    if (start) {
        await battle.evaluate((b, start) => b.seekTurn(start, true), start)
    }
    if (step1) {
        console.log([id, `searching for "${step1}"`]);
        while (true) {
            let thisStep = await battle.evaluate(b => b.stepQueue[b.currentStep]);
            console.log([id, thisStep])
            if (thisStep.startsWith(step1, 1)) break
            await battle.evaluate(b => {
                b.play() // call next step
                b.pause() // halt for processing
            })
        }
    }

    await mkdir[WEBM]; // just ensure that it's done
    let file = path.resolve(WEBM, `${id}.webm`)
    let recorder = await page.screencast({
        path: file,
        crop, speed: vspeed,
    })
    recorder.pause()
    state.once('playing', async () => {
        // noinspection JSUnresolvedReference
        await page.waitForFunction(() => !$('playbutton').length && !$('seeking').length, {polling: "mutation"});
        console.log([id, 'record'])
        recorder.resume()
        state.emit('record')
    });
    await battle.evaluate(b => b.play())
    await battleEnd
    await recorder.stop()
    await Promise.all([
        fixwebm(file, shouldOpen).then(() => {
            if (gif) {
                console.log([id, 'gif']);
                return makeGif(file, shouldOpen);
            }
        }),
        page.close()
    ])
    console.log([id, 'complete'])
}

async function fixwebm(file, shouldOpen) {
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
                if (shouldOpen) open(file, resolve)
                else resolve()
            })
            .on("error", (cause) => reject(new Error("Unable to fix metadata", {cause})))

        command.run()
    })
}

async function makeGif(file, shouldOpen = true, verbose = false) {
    await mkdir[GIF]
    const filename = path.basename(file, path.extname(file))
    const gif = path.join(GIF, filename + '.gif')
    const palette = file + '.png'
    const template = (resolve, reject, s) => s
        .on('start', (cmd) => {
            if (verbose) console.log(cmd)
        })
        .on('end', resolve)
        .on('error', reject)

    return new Promise((resolve, reject) =>
        template(resolve, reject, ffmpeg(file))
            .videoFilter('palettegen')
            .save(palette)
    ).then(() => new Promise((resolve, reject) => template(resolve, reject, ffmpeg())
            .addInput(file)
            .addInput(palette)
            .complexFilter('paletteuse')
            .outputFPS(15)
            .save(gif)
        )
    )
        .catch(console.error)
        .finally(() => {
            fs.rmSync(palette)
            if (shouldOpen) return new Promise(resolve => open(gif, resolve))
        })
        .catch(() => {
        }) // do nothing

}