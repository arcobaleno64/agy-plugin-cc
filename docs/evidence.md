# Evidence that has been seen to fail

Most of this plugin's hard bugs are intermittent, Windows-specific, or both. The
instruments used to investigate them — a probe, a sampler, a new assertion — fail
silently: a broken instrument and a working system both look green. So the rule
here is one habit, applied in four places:

**Nothing counts as evidence until it has been seen to fail.**

## The four places

**A test.** Break the code it covers and watch it go red. If it stays green it is
protecting nothing, however reasonable it reads. Two assertions in this repository
passed every run while asserting nothing: one compared `indexOf(...) < indexOf(...)`
where the first line was absent, and `-1` sorts before everything, so it passed
most confidently in exactly the case it existed to catch.

**A probe or harness.** Run it against the *unfixed* system first. If it cannot
reproduce the failure, a clean result from it means nothing. A probe written to
stage an orphaned process spawned its child undetached, so Windows collected it
along with its parent; the probe reported "no survivors" and nearly became
evidence that a real defect was absent.

**A sampler.** Stage an event of known duration and confirm the sampler catches it
before trusting a negative. A 100ms poll missed a ~700ms job-phase transition and
produced the confident, wrong claim that the phase never appears.

**A claim.** Name the observation that would falsify it, and run that observation.
If it was never run, the claim is *inferred*, not measured, and says so in the
commit message and the comment. A mechanism explained in a changelog entry, a
commit and a PR description here was contradicted the next day by the first
measurement anyone took of it.

## A control comes before a conclusion

A reading with no discriminating power looks exactly like a confirmed prediction.
Chasing a leaked process, the prediction "it will report `IsProcessInJob=false`"
was confirmed — and so were all 24 healthy processes measured alongside it. Without
that control the investigation would have shipped the wrong mechanism.

## Traps this repository has already paid for

- `node:test` attributes a throw inside `t.after` to the test that hook belongs to, so cleanup failures are reported under an unrelated assertion's name.
- A directory that is any live process's current directory cannot be deleted on Windows; `fs.rmSync` retries are not a fix for a process that outlives them.
- Windows never clears a process's parent link, so a reused pid inherits strangers. Any decision based on "children of pid N" needs a second signal — creation time works.
- Measuring process semantics from inside an agent harness measures the harness: its own processes may sit in a job object that collects everything they spawn.
- Looping the full test suite is a poor way to reproduce a rare failure. Run the one file that fails, many copies in parallel: this suite yields 2 relevant samples per 3.5 minutes, where 10 parallel copies of one file yield 20 in about a minute.
