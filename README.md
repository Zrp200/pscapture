# PSCapture

A Node.js application to make gifs or videos out of notable moments in a Pokemon Showdown! replay.

Inspired by [Intenzi/ShowdownReplayDownloader](https://github.com/Intenzi/ShowdownReplayDownloader), but uses a different capture method and does not directly capture https://replay.pokemonshowdown.com.

This uses Showdown's [replay-embed.js](https://github.com/smogon/pokemon-showdown-client/blob/master/play.pokemonshowdown.com/js/replay-embed.template.js) file to embed a chosen replay's protocol data into a headless browser and records it.

Multiple replays can be processed at once, though results may vary and optimization of this is pending.

Currently, it will make two directories in the working directory for outputs. This will probably be configurable in the future.

## Installation

1. Clone the directory
2. run `npm install` in the root of the directory
3. run `node pscapture` with your desired arguments.

## Limitations

* Sound is not currently supported when outputting in video formats
* Output quality currently varies widely by machine
* Generated gifs may be very large if capturing a long moment
* All replays must be valid Pokemon Showdown! replays. Direct log file/downloaded html support is planned but not yet implemented.

## Usage:
```pscapture [<src> [[range] [replay_opts]]..```

### Positionals:
#### src 
Link to the replay. The "https://play.pokemonshowdown" is optional.

This must be the first positional given, but it can be given again to generate clips from different replays in the same command

#### range
Turn range to capture, of the form `begin-end`

both `begin` and `end` can be omitted; `begin` defaults to the start of the battle, `end` defaults to the end of it.

Steps can also be provided to provide more control over what to capture. For example, `4move-faint` would start at turn 4 at the first move. The steps are found by matching the start of the current step, so `move` would match any step starting with`|move`

More details:
* a given step will be matched against the start of a protocol:
  * passing 'switch' will match the first '|switch' command generally if passed as a start, and it will match the first '|switch' after the start point when passed as the end
  * passing '6switch' will match the first '|switch' in turn 6
* 'all' will capture the whole battle. It's not suggested to make this a gif.
* timestamps can be directly given for both start and end

Getting a more exact end step:
* The end step can be prefixed with ^ (like "5-6^move|p2" or just "5-^move|p2") to specifically exclude that step.
  * Otherwise, the end step is considered to be inclusive, and will be included in the capture.
* The end step can be prefixed with ~ (like "5-6~faint" to exclude any minor steps after the end step.
  * This can be handy to exclude leftovers recovery or life orb recoil.
  * This has no effect when matching minor steps.

If only `begin` is given, (turns=6, for example) `end` is assumed to be the same turn, and the gif will cover only that turn.

### Replay Options
#### -r, --reverse
reverse viewpoint of battle
#### --player, --side
viewpoint to use for battle, by player name. Throws an error if the player isn't found.

mutually exclusive with reverse
#### --show
Show chat or teams (the sidebars) and/or chat. Default is to hide these.

choices: false (--no-show), "teams" (show chat and teams, enables nicknames), "chat" (show chat)

default: false (show only the main battle)
#### --speed
adjust time between messages. affects output speed.

hyperfast disables animations

choices: "very slow", "slow", "normal", "fast", "hyperfast"
default: "fast"
#### --vspeed
output video speed

#### --gen
Takes a number. Override the sprite generation

#### --hardcore
hide extra information not present in game

#### --turns
Show the turn indicator, default true

#### --gif
generate a gif with this input, default true

#### --mp4
generate a mp4 with this input, default false. Using this option changes the --gif default to false

#### --open
open the gif/webm after generation

#### --show-steps
when not processing the entire battle, log the part of the protocol captured. This is helpful for finding the best start and end step for a given capture. 

### Options:
#### --help                
Show help
#### --version             
Show version number
#### -b, --bulk
How many instances to run at once, if giving more than one argument
#### --headless                                       
hide browsers windows. default true.
