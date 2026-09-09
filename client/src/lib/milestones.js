/**
 * The capstone milestone sequence.
 *
 * Shared because two screens disagree about it at their peril: the student
 * dashboard renders the tracker, and the adviser's wrap-up is what moves it.
 *
 * The keys are what `public.group_milestones` stores and are fixed by a check
 * constraint; the labels are ours alone, so rewording a step here cannot orphan
 * a group's recorded progress. Adding a step is a migration, because it changes
 * what every group is measured against.
 */
export const MILESTONES = [
  { key: 'title_proposal', label: 'Title Proposal' },
  { key: 'chapters_1_3', label: 'Chapters 1-3' },
  { key: 'data_gathering', label: 'Data Gathering' },
  { key: 'system_review', label: 'System Review' },
  { key: 'final_defense', label: 'Final Defense' },
];

/**
 * What a milestone asks of a group. The same for every group at that stage,
 * which is why this is a constant and the progress beside it is not.
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
 * these off out of order -- a group can have their title approved and their
 * data gathered while chapters 1-3 are still in revision, and a count would
 * quietly promote the wrong step to "in progress".
 */
export function readMilestones(rows) {
  const completed = new Set((rows ?? []).map((row) => row.milestone));
  const reached = MILESTONES.filter((item) => completed.has(item.key)).length;
  const next = MILESTONES.find((item) => !completed.has(item.key)) ?? null;

  return {
    completed,
    progress: Math.round((reached / MILESTONES.length) * 100),
    next,
  };
}
