const {launch, EventEmitter} = require("puppeteer");
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
    {
        src,
        turnData,
        show = false,
        reverse = false,
        vspeed = 1,
        speed,
        gif = true,
        browser = launch(),
        shouldOpen = true,
        id,
    }) {
    if (!src.startsWith(PREFIX)) src = PREFIX + src
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

    /// get page to work with
    const page = await (await browser).newPage()
    const {log, id: battleID} = await page.goto(`${src}.json`).then(i => i.json())
    await page.setContent(`<input name="replayid" value="${battleID}" hidden="hidden"><script class="battle-log-data" type="text/plain">${log}</script><script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>`);
    let battle = await page.evaluateHandle(() => Replays.battle)
    if (reverse) {
        await battle.evaluate(b => b.switchViewpoint())
    }
    if (!id) {
        let name = ''
        if (start) name += start
        if (step1) name += step1
        if (step2 || end && end !== start + 1) {
            name += '-'
            if (end && step2 || end !== start + 1) name += end
            if (step2) name += step2;
        }
        if (reverse) name += '_p2'
        if (speed) name += '_' + speed
        id = name ? `${battleID}_${name}` : battleID;
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

    const showChat = show === 'chat'

// options
    await battle.evaluate((b, showChat, speed) => {
        b.subscribe(window.sub)
        b.ignoreNicks = !showChat
        b.setMute(true); // we don't support sound right now
        if (speed) Replays.changeSetting('speed', speed);
    }, showChat, speed)


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
        await page.waitForFunction(
            b => !b.getElementsByClassName('seeking').length && !b.getElementsByClassName('playbutton').length,
            {polling: "mutation"},
            await battleFrame
        );
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
            .addInputOption('-y')
            .addInputOption("-filter_complex paletteuse")
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