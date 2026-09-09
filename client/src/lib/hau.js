/**
 * Holy Angel University departments and their courses.
 *
 * VERIFY THIS LIST against HAU's official program offerings before you submit
 * the project -- it is assembled from public information and may be out of date
 * or incomplete. Editing this one file updates both dropdowns.
 */
export const DEPARTMENTS = {
  'School of Computing': [
    'BS Information Technology',
    'BS Computer Science',
    'BS Information Systems',
    'BS Entertainment and Multimedia Computing',
  ],
  'School of Business and Accountancy': [
    'BS Accountancy',
    'BS Management Accounting',
    'BS Business Administration',
    'BS Real Estate Management',
    'BS Entrepreneurship',
  ],
  'School of Engineering and Architecture': [
    'BS Civil Engineering',
    'BS Computer Engineering',
    'BS Electrical Engineering',
    'BS Electronics Engineering',
    'BS Industrial Engineering',
    'BS Mechanical Engineering',
    'BS Architecture',
  ],
  'School of Arts and Sciences': [
    'AB Communication',
    'AB Political Science',
    'AB Psychology',
    'BS Psychology',
    'BS Biology',
  ],
  'School of Education': [
    'Bachelor of Elementary Education',
    'Bachelor of Secondary Education',
    'Bachelor of Physical Education',
    'Bachelor of Early Childhood Education',
  ],
  'School of Nursing and Allied Medical Sciences': [
    'BS Nursing',
    'BS Medical Technology',
    'BS Pharmacy',
  ],
  'School of Hospitality and Tourism Management': [
    'BS Hospitality Management',
    'BS Tourism Management',
  ],
  'School of Criminology': ['BS Criminology'],
};

export const DEPARTMENT_NAMES = Object.keys(DEPARTMENTS);

export const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];

/** Academic ranks an adviser can pick during sign-up. Mirrors FACULTY_POSITIONS in the API. */
export const FACULTY_POSITIONS = [
  'Professor',
  'Associate Professor',
  'Assistant Professor',
  'Senior Lecturer',
  'Lecturer',
  'Instructor',
];

/**
 * The account type an address will create, mirroring roleForEmail() in the API.
 * Advisory only - the server decides for real, from the verified address.
 */
export function roleForEmail(email) {
  const address = String(email).trim().toLowerCase();
  if (address.endsWith('@hau.edu.ph')) return 'adviser';
  if (address.endsWith('@student.hau.edu.ph')) return 'student';
  return null;
}
