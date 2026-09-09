# Mock adviser accounts

Demo logins created by [0001_mock_advisers.sql](0001_mock_advisers.sql) — 5 advisers
per department, 40 in total. The people and the mailboxes are invented; the
addresses do not receive mail, so these accounts only work through the
**password sign-in** (Sign in tab), never through the OTP sign-up flow.

**Password for every account: `Adviser@2026`**

Delete them before the real deployment:

```sql
delete from auth.users u using public.profiles p
 where p.id = u.id and p.employee_id like 'FAC-10%';
```

## School of Computing

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| mreyes@hau.edu.ph | Reyes, Marco A. | Professor | FAC-1001 |
| lsantos@hau.edu.ph | Santos, Liza B. | Associate Professor | FAC-1002 |
| kbautista@hau.edu.ph | Bautista, Karl D. | Assistant Professor | FAC-1003 |
| gocampo@hau.edu.ph | Ocampo, Grace M. | Senior Lecturer | FAC-1004 |
| pvillanueva@hau.edu.ph | Villanueva, Paolo R. | Instructor | FAC-1005 |

## School of Business and Accountancy

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| amendoza@hau.edu.ph | Mendoza, Anna L. | Professor | FAC-1006 |
| rcruz@hau.edu.ph | Cruz, Ramon T. | Associate Professor | FAC-1007 |
| blim@hau.edu.ph | Lim, Beatriz S. | Assistant Professor | FAC-1008 |
| dyumul@hau.edu.ph | Yumul, Dennis F. | Senior Lecturer | FAC-1009 |
| cpineda@hau.edu.ph | Pineda, Carmela V. | Instructor | FAC-1010 |

## School of Engineering and Architecture

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| adizon@hau.edu.ph | Dizon, Alfredo G. | Professor | FAC-1011 |
| mtolentino@hau.edu.ph | Tolentino, Maricar P. | Associate Professor | FAC-1012 |
| rmanalastas@hau.edu.ph | Manalastas, Renato C. | Assistant Professor | FAC-1013 |
| jsicat@hau.edu.ph | Sicat, Joanne E. | Senior Lecturer | FAC-1014 |
| egalang@hau.edu.ph | Galang, Elmer B. | Instructor | FAC-1015 |

## School of Arts and Sciences

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| tnavarro@hau.edu.ph | Navarro, Teresa I. | Professor | FAC-1016 |
| jramos@hau.edu.ph | Ramos, Julius K. | Associate Professor | FAC-1017 |
| baquino@hau.edu.ph | Aquino, Bianca N. | Assistant Professor | FAC-1018 |
| fsalazar@hau.edu.ph | Salazar, Ferdinand O. | Senior Lecturer | FAC-1019 |
| mbondoc@hau.edu.ph | Bondoc, Michelle A. | Instructor | FAC-1020 |

## School of Education

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| rlacson@hau.edu.ph | Lacson, Rosario D. | Professor | FAC-1021 |
| epunzalan@hau.edu.ph | Punzalan, Edgardo M. | Associate Professor | FAC-1022 |
| afeliciano@hau.edu.ph | Feliciano, Angeline C. | Assistant Professor | FAC-1023 |
| ngutierrez@hau.edu.ph | Gutierrez, Noel P. | Senior Lecturer | FAC-1024 |
| dsarmiento@hau.edu.ph | Sarmiento, Divina L. | Instructor | FAC-1025 |

## School of Nursing and Allied Medical Sciences

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| icastillo@hau.edu.ph | Castillo, Imelda R. | Professor | FAC-1026 |
| aalmazan@hau.edu.ph | Almazan, Arnold S. | Associate Professor | FAC-1027 |
| kroxas@hau.edu.ph | Roxas, Katrina J. | Assistant Professor | FAC-1028 |
| mfernandez@hau.edu.ph | Fernandez, Miguel A. | Senior Lecturer | FAC-1029 |
| sbuenaventura@hau.edu.ph | Buenaventura, Sheila M. | Instructor | FAC-1030 |

## School of Hospitality and Tourism Management

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| lagustin@hau.edu.ph | Agustin, Lorna B. | Professor | FAC-1031 |
| vpanganiban@hau.edu.ph | Panganiban, Victor E. | Associate Professor | FAC-1032 |
| rquiambao@hau.edu.ph | Quiambao, Rhea T. | Assistant Professor | FAC-1033 |
| jmiranda@hau.edu.ph | Miranda, Jomar C. | Senior Lecturer | FAC-1034 |
| ctorres@hau.edu.ph | Torres, Cecilia G. | Instructor | FAC-1035 |

## School of Criminology

| Username (email) | Name | Position | Faculty ID |
| --- | --- | --- | --- |
| rbulanadi@hau.edu.ph | Bulanadi, Rogelio P. | Professor | FAC-1036 |
| mespino@hau.edu.ph | Espino, Marlon D. | Associate Professor | FAC-1037 |
| jrivera@hau.edu.ph | Rivera, Jenny F. | Assistant Professor | FAC-1038 |
| hcabrera@hau.edu.ph | Cabrera, Hector L. | Senior Lecturer | FAC-1039 |
| psoriano@hau.edu.ph | Soriano, Patricia N. | Instructor | FAC-1040 |
