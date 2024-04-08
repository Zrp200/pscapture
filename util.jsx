const {EventEmitter} = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg")

const path = require("path")
const fs = require("fs")
const open = require('opener')

const turnSpec = /^(?:(?<start>\d+)|(?=[|]|start))[|]?(?<step1>(?:(?=\|)-\D)?[^-]+)?(?<to>-(?<end>\d+)?[|]?(?<step2>.+)?)?/
const PREFIX = 'https://replay.pokemonshowdown.com/';

const folders = ["webm", "gifs"]
const [WEBM, GIF] = folders
let mkdir = function () {
    let res = {}
    for (let folder of folders) res[folder] = new Promise(resolve => fs.mkdir(folder, resolve))
    return res
}()

const awaitSync = promises => promises.reduce((pre, cur) => pre.then(cur), Promise.resolve())

const defaults = {
    show: false,
    speed: 'fast',
    vspeed: 1,
    gif: true,
    turns: true,
    shouldOpen: true,
}

module.exports = {download, awaitSync, turnSpec, defaults}

async function download(
    page, {
        src,
        turnData,
        show = defaults.show,
        reverse = false, player,
        vspeed = 1,
        speed = defaults.speed,
        gen, hardcore,
        gif = defaults.gif,
        shouldOpen = defaults.shouldOpen,
        id,
        turns = defaults.turns, // show turn indicator
    }) {
    if (!src.startsWith(PREFIX)) src = PREFIX + src
    let {start, end, step1, step2} = function () {
        if (turnData && turnData['step2'] === 'end' && !turnData.end) delete turnData['step2']
        let {start, end, to} = turnData || {};
        start = parseInt(start)
        return {
            ...turnData,
            start,
            end: parseInt(end || (to ? 0 : start)),
        }
    }();

    /// get page to work with
    let {log, id: battleID, players} = await page.goto(`${src}.json`).then(i => i.json())
    if (player) {
        // todo add better verification for this or error handling
        switch (players.indexOf(player)) {
            case -1: throw Error(`invalid player ${player}, expected one of ${players}`);
            case 1: reverse = true;
        }
    }
    // modify log as needed
    if (gen) log = log.replace(RegExp("(?<=\\|gen\\|)\\d+"), gen)
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
        if (show !== defaults.show) name += `_show-${show}`
        if (speed !== defaults.speed) name += '_' + speed
        id = name ? `${battleID}_${name}` : battleID;
    }

    const turnMatcher = RegExp('(?=turn\\\\|)\\d+')
    const steps = await battle.evaluate((b) => b.stepQueue);
    let startStep = start && steps.indexOf(`|turn|${start}`)
    if (step1) {
        let i = startStep
        while (i < steps.length) {
            const step = steps[i].substring(1)
            if (end && step === (`turn|${end+1}`)) {
                // not found
                i = steps.length;
                break;
            }
            // update start for faster startup if we weren't given start
            const m = turnMatcher.exec(step)
            if (m) start = parseInt(m[0]);
            if (step.startsWith(step1)) break;
            // record the last major step or divider before this one
            if (!step || !step.startsWith('-')) startStep = i;
            i++;
        }
        if (i === steps.length) throw Error(`${id}: start not found!`)
    }
    // end of queue (exclusive)
    const endStep = (end || step2) &&  (() => {
        if (!step2) return steps.indexOf(`|turn|${end+1}`, startStep)
        let i = end ? steps.indexOf(`|turn|${end}`, startStep) : startStep
        // current behavior won't match same turn
        while(++i < steps.length) {
            const step = steps[i].substring(1)
            if (step.startsWith(step2)) break;
            if (end && step.startsWith('turn')) return i; // not found
        }
        // search until we get a major action or a divider
        while (++i < steps.length) {
            const step = steps[i].substring(1)
            // new major action stop at major action
            if(step && step[0] !== '-') return i;
        }
        return 0;
    })()
    //console.log({id, startStep, endStep})
    // cut the queue at the end if needed
    if (endStep) {
        steps.splice(endStep)
        await battle.evaluate((b, q) => b.stepQueue = q, steps)
    }

    // -- start logic; find start step
    // todo maybe if I mess with the queue, I can get it to seek the start aspect directly.
    if (start && !step1) {
        // direct seek if we are able
        await battle.evaluate((b, start) => b.seekTurn(start, true), start)
    } else if (startStep) {
        // seek the exact start step by messing with the queue
        await battle.evaluate((b, q)=> {
            const orig = b.stepQueue
            // cut the queue at the point we want to seek to
            b.stepQueue = q
            b.seekTurn(Infinity, true)
            b.stepQueue = orig
            b.atQueueEnd = false
        }, steps.toSpliced(startStep+1))
    }

    let state = new EventEmitter()

    const battleEnd = new Promise(resolve => state.on('atqueueend', resolve))

    // -- options/setup
    await page.exposeFunction('sub', (type, ...args) => {
        // turn has custom logic since 'turn' is super useless by itself
        if (state.emit(type, args) && type !== 'turn') console.log([id, type])
    })


    const showChat = show === 'chat'

    const delay = await battle.evaluate((b, showChat, speed, hardcore) => {
        b.subscribe(window.sub)
        b.ignoreNicks = !showChat
        // noinspection JSUnresolvedReference
        b.setMute(true); // we don't support sound right now
        if (speed) Replays.changeSetting('speed', speed);
        if (hardcore) { // noinspection JSUnresolvedReference
            b.setHardcoreMode(true)
        }
        return b.messageFadeTime;
    }, showChat, speed, hardcore)

    // -- cropping logic
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

    // -- recording logic
    await mkdir[WEBM]; // just ensure that it's done
    let file = path.resolve(WEBM, `${id}.webm`)
    if (!startStep) {
        // show team preview if showing team 0
        // wonder if I should add a toggle for this
        await page.$eval('.playbutton', p => p.style.display = 'none')
    }
    let recorder = await page.screencast({
        path: file,
        crop, speed: vspeed,
    })
    console.log([id, 'record'])
    if (!startStep) await new Promise(r => setTimeout(r, 1000)) // capture team preview
    await battle.evaluate(b => b.play())
    await battleEnd
    await new Promise(r => setTimeout(r, delay)) // give some extra time for the animations to finish
    await recorder.stop()
    await Promise.all([
        fixwebm(file, shouldOpen && !gif).then(() => {
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