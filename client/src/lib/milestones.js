/**
 * The capstone milestone sequence.
 *
 * The steps used to be this constant. They are now rows in `program_milestones`,
 * keyed by department, because five steps that fit a computing capstone do not
 * fit a nursing one. What survives here is the fallback the database is seeded
 * with, the canned advice attached to those particular steps, and the arithmetic
 * every screen does over whichever sequence applies.
 *
 * Keys are what the database stores; labels are display only, so renaming a step
 * in the coordinator's editor never orphans a group's recorded progress.
 */
export const FALLBACK_MILESTONES = [
  { key: 'title_proposal', label: 'Title Proposal' },
  { key: 'chapters_1_3', label: 'Chapters 1-3' },
  { key: 'data_gathering', label: 'Data Gathering' },
  { key: 'system_review', label: 'System Review' },
  { key: 'final_defense', label: 'Final Defense' },
];

/**
 * What a milestone asks of a group.
 *
 * Only the seeded steps have advice: a coordinator inventing "Ethics Clearance"
 * has not told us what it involves, and guessing would be worse than saying
 * nothing. A step with no entry simply shows no checklist.
 */
export const MILESTONE_ACTIONS = {
  title_proposal: [
    'Draft the problem statement',
    'Line up three candidate titles',
    'Book a consultation to review them',
  ],
  chapters_1_3: [
    'Finish the review of related literature',
    'Settle the research methodology',
    'Send chapters to your adviser before the session',
  ],
  data_gathering: [
    'Finalise the instrument',
    'Secure the respondents and permissions',
    'Log the responses as they arrive',
  ],
  system_review: [
    'Review system requirements',
    'Prepare the demo build',
    'Book a consultation for the walkthrough',
  ],
  final_defense: [
    'Fold in every adviser revision',
    'Rehearse the defense deck',
    'Confirm the panel schedule',
  ],
};

/**
 * Turns the rows the API returns into what the milestone panels need.
 *
 * `completed` is a set of keys rather than a count, because an adviser can sign
 * these off out of order -- a group can have their title approved and their data
 * gathered while chapters 1-3 are still in revision, and a count would quietly
 * promote the wrong step to "in progress".
 *
 * `sequence` is whichever set the group's department uses; it falls back to the
 * seeded five so a screen that has not loaded it yet still renders something
 * truthful rather than an empty tracker.
 */
export function readMilestones(rows, sequence) {
  const steps = sequence?.length ? sequence : FALLBACK_MILESTONES;
  const completed = new Set((rows ?? []).map((row) => row.milestone));
  const reached = steps.filter((item) => completed.has(item.key)).length;
  const next = steps.find((item) => !completed.has(item.key)) ?? null;

  return {
    steps,
    completed,
    progress: steps.length ? Math.round((reached / steps.length) * 100) : 0,
    next,
  };
}
