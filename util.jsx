const {EventEmitter} = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path)

const path = require("path")
const fs = require("fs")
const open = require('opener')

const
    turnSpec = /^(?:(?<start>\d+)|(?=[|]|start|t|all))[|]?(?<step1>(?:(?=\|)-\D)?[^-]+)?(?<to>-(?<end>\d+)?[|]?(?<step2>.+)?)?/,
    turnMatcher = /(?<=^turn[|]?)\d+$/,
    PREFIX = 'https://replay.pokemonshowdown.com/';

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

module.exports = {download, awaitSync, parseTurns, turnSpec, defaults}

async function download(
    page, {
        src,
        turnData: {start, end, seekEnd = !end} = parseTurns('all'),
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
    if (gen) log = log.replace(/(?<=\|gen\|)\d+/, gen)
    await page.setContent(`<input name="replayid" value="${battleID}" hidden><script class="battle-log-data" type="text/plain">${log}</script><script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>`);
    if (!turns) await page.addStyleTag({content: ".turn { display: none }"})
    let battle = await page.evaluateHandle(() => Replays.battle)
    if (reverse) {
        await battle.evaluate(b => b.switchViewpoint())
    }
    if (!id) {
        let name = '';
        const toStr = ({turn, step}) => [turn, step].filter(i => i).join();
        name += toStr(start)
        if (seekEnd && name) name += `-${toStr(end) || 'end'}`;
        const parts = [battleID];
        if (name) {
            // remove illegal characters
            parts.push(name.replaceAll(/[^\w\-_]/g, ''));
            // add additional properties
            if (reverse) parts.push('p2');
            if (show !== defaults.show) parts.push(`show-${show}`);
            if (speed !== defaults.speed) parts.push(speed);
            if (vspeed !== defaults.vspeed) parts.push(vspeed + 'x');
        }
        id = parts.join('_');
    }

    const timeStampMatcher = /(?<=^t:\|)\d+$/
    const steps = await battle.evaluate((b) => b.stepQueue);
    let startStep = start.turn && steps.indexOf(`|turn|${start.turn}`)
    if (start && start.step) {
        let i = startStep
        while (i < steps.length) {
            const step = steps[i].substring(1)
            if (end.turn && step === (`turn|${end.turn+1}`)) {
                // not found
                i = steps.length;
                break;
            }
            // update start for faster startup if we weren't given start
            const m = turnMatcher.exec(step)
            if (m) start.turn = parseInt(m[0]);
            if (start.time) {
                // optimize if using a timestamp; we don't have to assume nearly as much
                const
                    [time] = timeStampMatcher.exec(step) || [0],
                    diff = start.time - time;
                if (diff <= 0) {
                    startStep = diff ? steps.length : i;
                    break;
                } // use this as the stopping point. if we passed it, then just stop here.
            } else {
                startStep = i;
                if (step.startsWith(start.step)) break;
                // record the last major step or divider before this one
                if (!step || !step.startsWith('-')) startStep = i;
            }
            i++;
        }
        if (i === steps.length) throw Error(`${id}: start not found!`)
    }
    if (!seekEnd) end.turn = start.turn;
    // end of queue (exclusive)
    const endStep = (() => {
        if (!end.step && !end.time) return end.turn && steps.indexOf(`|turn|${end.turn+1}`, startStep);
        let i = end.turn ? steps.indexOf(`|turn|${end.turn}`, startStep) : startStep
        // current behavior won't match same turn
        while(++i < steps.length) {
            const step = steps[i].substring(1)
            const minor= step.charAt(0) === '-';
            if (end.time || end.step === 't') {
                // fixme duplicated
                // optimize if using a timestamp; we don't have to assume nearly as much
                const [time] = timeStampMatcher.exec(step) || [];
                if (time && end.step === 't' || time - end.time >= 0) return i; // use this as the stopping point. if we passed it, then just stop here.
            } else if (step.startsWith(end.step, minor && !end.step.startsWith('-') ? 1 : 0)) {
                if (minor) return i+1; // stop one action after this
                break;
            }
            if (end.turn && step.startsWith('turn')) return i; // not found
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
        //console.log(steps.slice(startStep))
        await battle.evaluate((b, q) => b.stepQueue = q, steps)
    }

    let state = new EventEmitter()
    const battleEnd = new Promise(resolve => state.once('record', () => {
        state.on('atqueueend', resolve);
        console.log([id, 'record']);
    }));

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

    // -- start logic; find start step
    if (start) {
        if (start.turn && !start.step) {
            // direct seek if we are able
            await battle.evaluate((b, start) => b.seekTurn(start, true), start.turn)
        } else if (startStep) {
            // seek the exact start step by messing with the queue
            await battle.evaluate((b, q)=> {
                const orig = b.stepQueue
                // cut the queue at the point we want to seek to
                b.stepQueue = q
                b.seekTurn(Infinity, true)
                b.stepQueue = orig
                b.atQueueEnd = false
            }, steps.toSpliced(startStep))
        }
    }

    // -- recording logic
    await mkdir[WEBM]; // just ensure that it's done
    let file = path.resolve(WEBM, `${id}.webm`)
    let teamPreview = false;
    if (!startStep) {
        // show team preview if showing team 0
        // wonder if I should add a toggle for this
        const s = await page.$eval('.playbutton', p => p.style.display = 'none')
        teamPreview = steps.includes('|teampreview')
        await s;
    }
    let recorder = await page.screencast({
        path: file,
        crop, speed: vspeed,
    })
    state.emit('record', undefined);
    if (teamPreview) await new Promise(r => setTimeout(r, 1000))
    await battle.evaluate(b => b.play())
    await battleEnd
    await new Promise(r => setTimeout(r, delay*2)) // give some extra time for the animations to finish
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
        const tmp = file + '.tmp.webm'
        const command = ffmpeg(file)
            .withVideoCodec("copy")
            .withAudioCodec("copy") // Copy the video and audio streams without re-encoding
            .output(tmp)
            .on("end", () =>
                fs.rm(file, () => fs.rename(
                    tmp, file,
                    !shouldOpen ? resolve : () => open(file, resolve)
                ))
            )
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
        .finally(() => Promise.all([
            new Promise(resolve => fs.rm(palette, resolve)),
            shouldOpen && new Promise(resolve => open(gif, resolve)),
        ]))
        .catch(console.error)

}

function parseTurns(turns) {
    let spec = turnSpec.exec(turns)
    if (!spec) throw Error( "Invalid Turn Spec");
    let {groups: turnData} = spec
    // -- process match edge cases
    let seekEnd = !!turnData.to; // convert to boolean if it isn't already
    const timestamp = ['',''];
    const rangeKeys = ['start', 'end'];
    rangeKeys.forEach((turn, index) => {
        const step = `step${index + 1}`;
        // this is basically just a processing pipeline
        for (const [[src, dst=src], match, transform] of [
            // -- detect timestamps. if turns are stupidly big they're probably timestamps.
            [[turn, step], (t, conflict=turnData[step]) => {
                if (t.length <= 4) return;
                if (conflict) throw Error(`Nonsensical turn ${t} given for ${turn}`);
                return `t:|${t}`;
            }],
            // -- turn specified by protocol "turn|TURN"
            [[step, turn], step => turnMatcher.exec(step), ([t], conflict=turnData[turn]) => {
                // turn specified in two ways at once (ie 3turn4) is meaningless
                if (conflict) throw Error(`turn ${t} specified by protocol, but turn given as ${conflict}`);
                return t;
            }],
            // -- convert turn from string to int
            //[[turn], parseInt],
            [[step], s => {
                // special cases
                switch(s) {
                    case 'all':
                        // this is just giving no arguments
                        if (seekEnd || turnData[turn]) throw Error('all should only be used by itself');
                        seekEnd = true;
                    // fall through
                    case 'end': // end is pointless
                        delete turnData[step];
                        break;
                    case 'turn':
                        // equivalent to just omit this
                        if(seekEnd && index === 1) seekEnd = !turnData[turn];
                        delete turnData[step];
                        break;
                    // identifier for stopping at next timestamp, instead of next turn
                    case 't':
                        if (index === 0) throw Error('t should not be used in start');
                        if (turnData[turn]) throw Error('t is incompatible with a turn argument')
                        // logic is used later
                        break;
                }
            }],
            // -- allow shorthand for timestamps
            // timestamps can be specified with 't:|TIME', 't:TIME', or 'tTIME'. this fixes the latter two.
            [[step], step => /(?<=^t(:\|?)?)\d+$/.exec(step), ([time]) => `t:|${timestamp[index] = time}`],
        ]) {
            let v = turnData[src] && match(turnData[src]);
            if (transform && v) v = transform(v);
            if (!v) continue;
            turnData[dst] = v;
            // swap turn and step if needed
            if (src !== dst) delete turnData[src];
        }
    });
    const [start, end] = rangeKeys.map( (k, i) => ({
        turn: parseInt(turnData[k] || 0),
        step: turnData[`step${i+1}`],
        time: timestamp[i],
    }))
    // verify ranges
    for (const k in ['turn', 'time']) if (start[k] && end[k] && start[k] > end[k]) {
        throw Error(`invalid ${k} range: ${[start[k], end[k]]}`)
    }
    return {start, end, seekEnd};
}