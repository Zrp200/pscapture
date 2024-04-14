const {launch} = require("puppeteer");
const yargs = require("yargs")

const {download, parseTurns, turnSpec, awaitSync, defaults} = require("./util.jsx")

const global = {
    bulk: {
        alias: 'b',
        describe: "How many instances to run at once, if giving more than one argument",
        default: true,
    },
    headless: { boolean: true, default: true }
};

// options configurable per replay. also configurable globally
const save = [
    ['reverse', {
        alias: ['r', 'p2'],
        describe: 'reverse viewpoint of battle',
        type: 'boolean',
    }],
    ['player', {
        alias: ['side'],
        describe: 'viewpoint to use for battle',
        conflicts: 'reverse'
    }],
    ['show', {
        describe: 'Show players, or show players and chat. "chat" also shows nicknames.',
        choices: [false, 'teams', "chat"],
    }],
    ['speed', {
        describe: 'adjust time between messages. affects output speed. hyperfast disables animations',
        choices: ['very slow', 'slow', 'normal', 'fast', 'hyperfast'],
    }],
    ['vspeed', {
        describe: 'output video speed',
        type: 'number',
    }],
    ['turns', {desc: 'Show the turn indicator', type: "boolean"}],
    ['gen', {desc: 'Override the sprite generation', type: 'number'}],
    ['hardcore', {desc: 'hide extra information not present in game'}],
    ['gif', {describe: "generate a gif with this input, otherwise just creates a webm", type: 'boolean'}],
    ['shouldOpen', {desc: 'immediately open result', boolean: true, alias: 'open'}],
].reduce((prev, [key, value],) => ({...prev, [key]: {...value, group: 'Replay Options'}}), {})

yargs()
    .usage("$0 [<src> [[range] [replay_opts]]...")

    .positional('src', {
        desc: 'Link to the replay. The "https://play.pokemonshowdown" is optional.'
    })
    .positional('range', {
        desc: 'turn range to capture. a descriptor can be used in addition or instead of a start or end range. Omitting or using "all" captures the whole thing.'
    })
    .example("$0 oumonotype-82345404 1-2faint 0-end")

    .options(global)
    .options(save)
    .demandCommand(1)
    .default(defaults)
    .strictOptions() // verify all options are legitimate
    .parse(process.argv.slice(2))

let {argv: {_: argv, bulk = true, headless = true}} = yargs(process.argv.slice(2))
    .parserConfiguration({"unknown-options-as-args": true})
    .options(global)

const browser = launch({headless, waitForInitialPage: false, args: ["--no-startup-window"]});
// split parts into sections
const parts = function* () {
    let parser = yargs().options(save)
    let last = {}, i = 0, j = argv.length;
    while (i < j) {
        const slice = argv.slice(i, j--);
        let {_: [src, turns, ...other], $0, ...opts} = parser.parse(slice);
        if (other.length || !src) continue;
        let m = turnSpec.test(src)
        try {
            if (m) {
                if (turns) continue; // two turn arguments
                // todo incorporate as middleware or something
                if (!last.src) throw Error('no src!'); // can't infer src from previous
                turns = src;
                src = undefined;
            }
            else if (!turnSpec.test(turns)) continue; // two src arguments
            else {
                opts.src = parseSrc(src, opts);
            }
            // fixme distinguish between exceptions from this and exceptions from other stuff
            if (turns) opts.turnData = parseTurns(turns);
        } catch (e) {
            console.error(`${slice}: ${e}`);
            return;
        }
        yield last = {...last, ...opts};
        i = j + 1;
        j = argv.length;
    }
}();

// parallelism check
let actions = [...parts].map((value,id,) => () => browser
    .then(browser => browser.createBrowserContext())
    .then(context => context.newPage())
    .then(page => download(page, value))
)
let n = typeof bulk == 'number' ? bulk >= actions.length || Math.ceil(actions.length / bulk) : bulk;
(!n ? awaitSync(actions)
    : Promise.all(
        n === true ? actions.map(it => it()) :
            function* () {
                // map into buckets, todo improve algorithm
                let i = 0;
                while (i < n) yield awaitSync(actions.slice(n * i, n * ++i))
            }()
    )).then(() => browser.then(b => b.close()))

// checker logic for download src argument
function parseSrc(src, opts) {
    const url = new URL(src, 'https://replay.pokemonshowdown.com');
    // cut out query parameters, change defaults as needed
    for (const [k,v] of url.searchParams) switch(k) {
        case 'p2':
            // change the default of reverse
            if (opts && opts.reverse === undefined) opts.reverse = true;
            break;
        case 'turn':
            // do nothing --- maybe in the future it'll change the default for turnspec
            break;
    }
    url.search = ''; // clear search params
    if (!url.pathname.endsWith('.json')) url.pathname += '.json'; // looking for json
    return url;
}