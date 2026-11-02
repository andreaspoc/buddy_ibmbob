import { brandText } from './lib/brand';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export const learningLanguages = [
  ['en', 'English'],
  ['el', 'Ελληνικά'],
  ['hi', 'हिन्दी'],
] as const;

export type LearningLangCode = (typeof learningLanguages)[number][0];

const storageKey = 'buddy-learning-language';

export function normalizeLearningLanguage(raw?: string | null): LearningLangCode {
  const code = (raw || 'en').trim().toLowerCase().split(/[-_]/)[0];
  if (code === 'el' || code === 'hi') return code;
  return 'en';
}

export function getLearningLanguage(): LearningLangCode {
  try {
    return normalizeLearningLanguage(localStorage.getItem(storageKey));
  } catch {
    return 'en';
  }
}

export function orderedLearningLanguages(selected: string = getLearningLanguage()): LearningLangCode[] {
  const primary = normalizeLearningLanguage(selected);
  const all: LearningLangCode[] = ['en', 'el', 'hi'];
  return [primary, ...all.filter(code => code !== primary)];
}

export function languageLabel(code: string): string {
  const normalized = normalizeLearningLanguage(code);
  const found = learningLanguages.find(([c]) => c === normalized);
  return found ? found[1] : code.toUpperCase();
}

const phrases: Record<string, [string, string]> = {
  'Library': ['Βιβλιοθήκη', 'पुस्तकालय'],
  'Quizzes': ['Κουίζ', 'प्रश्नोत्तरी'],
  'Learning Buddy': ['Learning Buddy', 'Learning Buddy'],
  'Administrator': ['Διαχειριστής', 'व्यवस्थापक'],
  'Teacher': ['Εκπαιδευτής', 'शिक्षक'],
  'Student': ['Μαθητής', 'विद्यार्थी'],
  'LEARNING FOLDERS': ['ΦΑΚΕΛΟΙ ΜΑΘΗΣΗΣ', 'अध्ययन फ़ोल्डर'],
  'ONLINE CLASSES': ['ΔΙΑΔΙΚΤΥΑΚΑ ΜΑΘΗΜΑΤΑ', 'ऑनलाइन कक्षाएं'],
  'YOUR LEARNING SPACE': ['Ο ΧΩΡΟΣ ΜΑΘΗΣΗΣ ΣΑΣ', 'आपका अध्ययन स्थान'],
  '← Back to Buddy': ['← Επιστροφή στον Buddy', '← Buddy पर वापस'],
  'Back to main app': ['Επιστροφή στην εφαρμογή', 'मुख्य ऐप पर वापस'],
  'Navigation': ['Πλοήγηση', 'नेविगेशन'],
  'Learning Actions': ['Ενέργειες μάθησης', 'सीखने की क्रियाएं'],
  'Learning Workspace': ['Χώρος μάθησης', 'अध्ययन कार्यस्थान'],
  'Ask Buddy': ['Ρωτήστε τον Buddy', 'Buddy से पूछें'],
  'Read. Explore. Put knowledge into practice.': ['Διαβάστε. Εξερευνήστε. Εφαρμόστε τη γνώση.', 'पढ़ें। जानें। ज्ञान का उपयोग करें।'],
  'Welcome to Learning Buddy': ['Καλώς ήρθατε στο Learning Buddy', 'Learning Buddy में स्वागत है'],
  'Search documents…': ['Αναζήτηση εγγράφων…', 'दस्तावेज़ खोजें…'],
  'Search quizzes…': ['Αναζήτηση κουίζ…', 'प्रश्नोत्तरी खोजें…'],
  'Search chapters…': ['Αναζήτηση κεφαλαίων…', 'अध्याय खोजें…'],
  'Search classes…': ['Αναζήτηση μαθημάτων…', 'कक्षाएं खोजें…'],
  'Search notes…': ['Αναζήτηση σημειώσεων…', 'नोट्स खोजें…'],
  '+ Upload document': ['+ Μεταφόρτωση εγγράφου', '+ दस्तावेज़ अपलोड करें'],
  '+ Create quiz': ['+ Δημιουργία κουίζ', '+ प्रश्नोत्तरी बनाएँ'],
  'Create a quiz': ['Δημιουργία κουίζ', 'प्रश्नोत्तरी बनाएँ'],
  'Create folder': ['Δημιουργία φακέλου', 'फ़ोल्डर बनाएँ'],
  'Create learning folder': ['Δημιουργία φακέλου μάθησης', 'अध्ययन फ़ोल्डर बनाएँ'],
  'Folder name': ['Όνομα φακέλου', 'फ़ोल्डर का नाम'],
  '+ New Class': ['+ Νέο Μάθημα', '+ नई कक्षा'],
  'Create Online Class': ['Δημιουργία Διαδικτυακού Μαθήματος', 'ऑनलाइन कक्षा बनाएँ'],
  'Class Settings': ['Ρυθμίσεις Μαθήματος', 'कक्षा सेटिंग्स'],
  'Class Name': ['Όνομα Μαθήματος', 'कक्षा का नाम'],
  'Class Description': ['Περιγραφή Μαθήματος', 'कक्षा का विवरण'],
  'All Classes': ['Όλα τα Μαθήματα', 'सभी कक्षाएं'],
  'All Online Classes': ['Όλα τα Διαδικτυακά Μαθήματα', 'सभी ऑनलाइन कक्षाएं'],
  'Select a class to access its structured chapters, interactive lectures, study materials, quizzes, and your personal sticky notes.': [
    'Επιλέξτε ένα μάθημα για πρόσβαση στα κεφάλαια, τις διαδραστικές διαλέξεις, το υλικό μελέτης, τα κουίζ και τις προσωπικές σας σημειώσεις.',
    'संरचित अध्यायों, इंटरैक्टिव व्याख्यानों, अध्ययन सामग्री, प्रश्नोत्तरी और अपने व्यक्तिगत स्टिकी नोट्स तक पहुँचने के लिए एक कक्षा चुनें।'
  ],
  'ONLINE ACADEMY': ['ΔΙΑΔΙΚΤΥΑΚΗ ΑΚΑΔΗΜΙΑ', 'ऑनलाइन अकादमी'],
  'ONLINE CLASS': ['ΔΙΑΔΙΚΤΥΑΚΟ ΜΑΘΗΜΑ', 'ऑनलाइन कक्षा'],
  'ONLINE CLASSROOM': ['ΔΙΑΔΙΚΤΥΑΚΗ ΤΑΞΗ', 'ऑनलाइन क्लासरूम'],
  'Chapters': ['Κεφάλαια', 'अध्याय'],
  'Chapter': ['Κεφάλαιο', 'अध्याय'],
  'Interactive Class': ['Διαδραστικό Μάθημα', 'इंटरैक्टिव कक्षा'],
  'Sticky Notes': ['Σημειώσεις', 'स्टिकी नोट्स'],
  'Classroom & Live': ['Τάξη & Ζωντανά', 'क्लासरूम और लाइव'],
  'Course Curriculum': ['Πρόγραμμα Σπουδών', 'पाठ्यक्रम'],
  'Follow each chapter in order: start with the interactive lecture, study the attached readings, and complete the chapter quiz.': [
    'Ακολουθήστε κάθε κεφάλαιο με τη σειρά: ξεκινήστε με τη διαδραστική διάλεξη, μελετήστε τα έγγραφα και ολοκληρώστε το κουίζ.',
    'प्रत्येक अध्याय का क्रम से पालन करें: इंटरैक्टिव व्याख्यान से शुरू करें, संलग्न सामग्री पढ़ें और अध्याय प्रश्नोत्तरी पूरी करें।'
  ],
  '+ New Chapter': ['+ Νέο Κεφάλαιο', '+ नया अध्याय'],
  'Edit Chapter': ['Επεξεργασία Κεφαλαίου', 'अध्याय संपादित करें'],
  'Start Chapter →': ['Έναρξη Κεφαλαίου →', 'अध्याय शुरू करें →'],
  'Continue Chapter →': ['Συνέχεια Κεφαλαίου →', 'अध्याय जारी रखें →'],
  'Review Chapter →': ['Επανάληψη Κεφαλαίου →', 'अध्याय की समीक्षा करें →'],
  'Completed': ['Ολοκληρώθηκε', 'पूर्ण'],
  'In progress': ['Σε εξέλιξη', 'प्रगति पर'],
  'Published': ['Δημοσιευμένο', 'प्रकाशित'],
  'Draft': ['Προσχέδιο', 'मसौदा'],
  'sections': ['ενότητες', 'अनुभाग'],
  'documents': ['έγγραφα', 'दस्तावेज़'],
  'quizzes': ['κουίζ', 'प्रश्नोत्तरी'],
  'notes': ['σημειώσεις', 'नोट्स'],
  'chapters': ['κεφάλαια', 'अध्याय'],
  'Enter Class →': ['Είσοδος στο Μάθημα →', 'कक्षा में प्रवेश करें →'],
  'Course Progress': ['Πρόοδος Μαθήματος', 'पाठ्यक्रम प्रगति'],
  'completed': ['ολοκληρώθηκαν', 'पूर्ण'],
  '+ Note': ['+ Σημείωση', '+ नोट'],
  '+ New Sticky Note': ['+ Νέα Σημείωση', '+ नया स्टिकी नोट'],
  'Class Sticky Notes': ['Σημειώσεις Μαθήματος', 'कक्षा स्टिकी नोट्स'],
  'Jot down key takeaways, formulas, and questions per chapter. Sync important notes directly to your main Bob Notes.': [
    'Κρατήστε βασικές σημειώσεις, τύπους και ερωτήσεις ανά κεφάλαιο. Συγχρονίστε τις σημαντικές σημειώσεις στο Bob Notes.',
    'प्रत्येक अध्याय के मुख्य बिंदु, सूत्र और प्रश्न लिखें। महत्वपूर्ण नोट्स को सीधे अपने मुख्य Bob Notes में सिंक करें।'
  ],
  'All Chapters': ['Όλα τα Κεφάλαια', 'सभी अध्याय'],
  'Favorites': ['Αγαπημένα', 'पसंदीदा'],
  'Synced to Bob Notes': ['Συγχρονισμένο με Bob Notes', 'Bob Notes के साथ सिंक किया गया'],
  'Sync to Bob Notes': ['Συγχρονισμός με Bob Notes', 'Bob Notes में सिंक करें'],
  'General Class Note': ['Γενική Σημείωση Μαθήματος', 'सामान्य कक्षा नोट'],
  'General Class Resources': ['Γενικοί Πόροι Μαθήματος', 'सामान्य कक्षा संसाधन'],
  'Course-wide reference documents and final assessments not tied to a single chapter.': [
    'Γενικά έγγραφα αναφοράς και τελικές αξιολογήσεις που αφορούν ολόκληρο το μάθημα.',
    'पूरे पाठ्यक्रम के संदर्भ दस्तावेज़ और अंतिम मूल्यांकन।'
  ],
  'Course Documents': ['Έγγραφα Μαθήματος', 'पाठ्यक्रम दस्तावेज़'],
  'Course Quizzes & Exams': ['Κουίζ & Εξετάσεις Μαθήματος', 'पाठ्यक्रम प्रश्नोत्तरी और परीक्षाएं'],
  'Chapter Documents': ['Έγγραφα Κεφαλαίου', 'अध्याय दस्तावेज़'],
  'Chapter Quizzes': ['Κουίζ Κεφαλαίου', 'अध्याय प्रश्नोत्तरी'],
  'Chapter Sticky Notes': ['Σημειώσεις Κεφαλαίου', 'अध्याय स्टिकी नोट्स'],
  'Start Quiz →': ['Έναρξη Κουίζ →', 'प्रश्नोत्तरी शुरू करें →'],
  'Start quiz →': ['Έναρξη κουίζ →', 'प्रश्नोत्तरी शुरू करें →'],
  'My Results': ['Τα Αποτελέσματά μου', 'मेरे परिणाम'],
  'View my results': ['Προβολή αποτελεσμάτων μου', 'मेरे परिणाम देखें'],
  '♙ Manage access': ['♙ Διαχείριση πρόσβασης', '♙ पहुँच प्रबंधित करें'],
  'Access': ['Πρόσβαση', 'पहुँच'],
  'Save access': ['Αποθήκευση πρόσβασης', 'पहुँच सहेजें'],
  'Keycloak groups': ['Ομάδες Keycloak', 'Keycloak समूह'],
  'Full group path': ['Πλήρης διαδρομή ομάδας', 'समूह का पूरा पथ'],
  'Add group': ['Προσθήκη ομάδας', 'समूह जोड़ें'],
  'Cancel': ['Ακύρωση', 'रद्द करें'],
  'Close': ['Κλείσιμο', 'बंद करें'],
  'Close dialog': ['Κλείσιμο διαλόγου', 'संवाद बंद करें'],
  'Save draft': ['Αποθήκευση προσχεδίου', 'मसौदा सहेजें'],
  'Save & Publish': ['Αποθήκευση & Δημοσίευση', 'सहेजें और प्रकाशित करें'],
  'Edit draft': ['Επεξεργασία προσχεδίου', 'मसौदा संपादित करें'],
  'Edit quiz draft': ['Επεξεργασία προσχεδίου κουίζ', 'प्रश्नोत्तरी मसौदा संपादित करें'],
  'Approve & publish': ['Έγκριση και δημοσίευση', 'स्वीकृत और प्रकाशित करें'],
  'Approve new version': ['Έγκριση νέας έκδοσης', 'नए संस्करण को स्वीकृत करें'],
  'Close quiz': ['Κλείσιμο κουίζ', 'प्रश्नोत्तरी बंद करें'],
  'Results': ['Αποτελέσματα', 'परिणाम'],
  'Quiz title': ['Τίτλος κουίζ', 'प्रश्नोत्तरी का शीर्षक'],
  'Question type': ['Τύπος ερώτησης', 'प्रश्न का प्रकार'],
  'Question': ['Ερώτηση', 'प्रश्न'],
  'Single choice': ['Μία επιλογή', 'एक विकल्प'],
  'Multiple choice': ['Πολλαπλές επιλογές', 'एकाधिक विकल्प'],
  'Dropdown': ['Αναπτυσσόμενη λίστα', 'ड्रॉपडाउन'],
  'Written answer': ['Γραπτή απάντηση', 'लिखित उत्तर'],
  'Points': ['Βαθμοί', 'अंक'],
  'Reference answer': ['Ενδεικτική απάντηση', 'संदर्भ उत्तर'],
  'Marking guidance': ['Οδηγίες βαθμολόγησης', 'अंकन मार्गदर्शन'],
  'Remove question': ['Αφαίρεση ερώτησης', 'प्रश्न हटाएँ'],
  '+ Add question': ['+ Προσθήκη ερώτησης', '+ प्रश्न जोड़ें'],
  '+ Add option': ['+ Προσθήκη επιλογής', '+ विकल्प जोड़ें'],
  'Submit answers': ['Υποβολή απαντήσεων', 'उत्तर जमा करें'],
  'Your answers were submitted': ['Οι απαντήσεις σας υποβλήθηκαν', 'आपके उत्तर जमा हो गए'],
  'Thank you. Results are available only to administrators.': ['Ευχαριστούμε. Τα αποτελέσματα είναι διαθέσιμα μόνο στους διαχειριστές.', 'धन्यवाद। परिणाम केवल व्यवस्थापकों को उपलब्ध हैं।'],
  'Back to folder': ['Επιστροφή στον φάκελο', 'फ़ोल्डर पर वापस'],
  'Choose an answer…': ['Επιλέξτε απάντηση…', 'उत्तर चुनें…'],
  'Select all that apply.': ['Επιλέξτε όσα ισχύουν.', 'सभी लागू विकल्प चुनें।'],
  'Read document →': ['Ανάγνωση εγγράφου →', 'दस्तावेज़ पढ़ें →'],
  'Draft quiz with Buddy': ['Προσχέδιο κουίζ με Buddy', 'Buddy से प्रश्नोत्तरी मसौदा बनाएँ'],
  'Delete document': ['Διαγραφή εγγράφου', 'दस्तावेज़ हटाएँ'],
  'Download original': ['Λήψη πρωτοτύπου', 'मूल डाउनलोड करें'],
  'Contents': ['Περιεχόμενα', 'विषय-सूची'],
  'Bookmarks': ['Σελιδοδείκτες', 'बुकमार्क'],
  'Text size': ['Μέγεθος κειμένου', 'पाठ का आकार'],
  'Search': ['Αναζήτηση', 'खोजें'],
  'Search this document…': ['Αναζήτηση στο έγγραφο…', 'इस दस्तावेज़ में खोजें…'],
  'Clear search': ['Εκκαθάριση αναζήτησης', 'खोज साफ़ करें'],
  'No matches found.': ['Δεν βρέθηκαν αποτελέσματα.', 'कोई परिणाम नहीं मिला।'],
  '← Library': ['← Βιβλιοθήκη', '← पुस्तकालय'],
  '← Previous': ['← Προηγούμενο', '← पिछला'],
  'Next →': ['Επόμενο →', 'अगला →'],
  'Import from Office Suite': ['Εισαγωγή από Office Suite', 'Office Suite से आयात करें'],
  'Import document': ['Εισαγωγή εγγράφου', 'दस्तावेज़ आयात करें'],
  'Search Office files…': ['Αναζήτηση αρχείων Office…', 'Office फ़ाइलें खोजें…'],
  'Load more': ['Περισσότερα', 'और लोड करें'],
  'Buddy assistant': ['Βοηθός Buddy', 'Buddy सहायक'],
  'Message Buddy': ['Μήνυμα στον Buddy', 'Buddy को संदेश'],
  'Send to Buddy': ['Αποστολή στον Buddy', 'Buddy को भेजें'],
  'Buddy is thinking…': ['Ο Buddy σκέφτεται…', 'Buddy सोच रहा है…'],
  'Review draft': ['Έλεγχος προσχεδίου', 'मसौदे की समीक्षा करें'],
  'Private draft created': ['Δημιουργήθηκε ιδιωτικό προσχέδιο', 'निजी मसौदा बनाया गया'],
  'Quiz & Buddy language': ['Γλώσσα μάθησης & Buddy', 'अध्ययन और Buddy की भाषा'],
  'Language': ['Γλώσσα', 'भाषा'],
  'Interactive lessons': ['Διαδραστικά μαθήματα', 'इंटरैक्टिव पाठ'],
  'Human-authored lessons, activities and videos. Resume where you left off.': [
    'Διαδραστικές διαλέξεις, δραστηριότητες και βίντεο. Συνεχίστε από εκεί που σταματήσατε.',
    'मानव-निर्मित पाठ, गतिविधियाँ और वीडियो। जहाँ आपने छोड़ा था वहीं से शुरू करें।'
  ],
  '+ Create lesson': ['+ Δημιουργία μαθήματος', '+ पाठ बनाएँ'],
  'Edit lesson': ['Επεξεργασία μαθήματος', 'पाठ संपादित करें'],
  'Create lesson': ['Δημιουργία μαθήματος', 'पाठ बनाएँ'],
  'Preview lesson': ['Προεπισκόπηση μαθήματος', 'पाठ का पूर्वावलोकन'],
  'Export editable lesson': ['Εξαγωγή επεξεργάσιμου μαθήματος', 'संपादन योग्य पाठ निर्यात करें'],
  'Back to lessons': ['Επιστροφή στα μαθήματα', 'पाठों पर वापस जाएँ'],
  'Back to editor': ['Επιστροφή στον επεξεργαστή', 'संपादक पर वापस जाएँ'],
  'Open lesson': ['Άνοιγμα μαθήματος', 'पाठ खोलें'],
  'Preview': ['Προεπισκόπηση', 'पूर्वावलोकन'],
  'Copy as new lesson': ['Αντιγραφή ως νέο μάθημα', 'नए पाठ के रूप में कॉपी करें'],
  'Draft Quiz': ['Προσχέδιο Κουίζ', 'प्रश्नोत्तरी मसौदा'],
  'Delete': ['Διαγραφή', 'हटाएँ'],
  'Save & continue': ['Αποθήκευση & συνέχεια', 'सहेजें और जारी रखें'],
  'Complete lesson': ['Ολοκλήρωση μαθήματος', 'पाठ पूरा करें'],
  'Finish preview': ['Τέλος προεπισκόπησης', 'पूर्वावलोकन समाप्त करें'],
  'Previous': ['Προηγούμενο', 'पिछला'],
  'Check answer': ['Έλεγχος απάντησης', 'उत्तर जाँचें'],
  'Choose an answer': ['Επιλέξτε μια απάντηση', 'एक उत्तर चुनें'],
  'Lesson complete': ['Το μάθημα ολοκληρώθηκε', 'पाठ पूरा हुआ'],
  'Review lesson': ['Επανάληψη μαθήματος', 'पाठ की समीक्षा करें'],
  'Explore more lessons': ['Εξερευνήστε περισσότερα μαθήματα', 'अधिक पाठ देखें'],
  '3-Language Content Approval': ['Έγκριση Περιεχομένου 3 Γλωσσών', '3-भाषा सामग्री अनुमोदन'],
  'Generate 3 Languages': ['Δημιουργία 3 Γλωσσών', '3 भाषाएँ जनरेट करें'],
  'Approve All 3 Languages & Finish Draft': ['Έγκριση 3 Γλωσσών & Ολοκλήρωση', 'तीनों भाषाओं को स्वीकृत करें और समाप्त करें'],
  'Approved': ['Εγκρίθηκε', 'स्वीकृत'],
  'Pending approval': ['Εκκρεμεί έγκριση', 'अनुमोदन लंबित'],
  'Course completion': ['Ολοκλήρωση μαθήματος', 'पाठ्यक्रम पूर्णता'],
  'Learner completion': ['Ολοκλήρωση εκπαιδευομένων', 'शिक्षार्थी पूर्णता'],
};

const codes: Array<'el' | 'hi'> = ['el', 'hi'];

export function translateLearning(text: string, language: string = getLearningLanguage()): string {
  return brandText(translateLearningText(text, language));
}

function translateLearningText(text: string, language: string): string {
  const norm = normalizeLearningLanguage(language);
  if (norm === 'en') return text;
  const index = codes.indexOf(norm);
  return index >= 0 ? phrases[text]?.[index] || text : text;
}

const LanguageContext = createContext({
  language: 'en' as LearningLangCode,
  direction: 'ltr' as 'ltr' | 'rtl',
  setLanguage: (_value: string) => {},
  t: (text: string) => text,
});

export function LearningLanguageProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<LearningLangCode>(getLearningLanguage);
  const direction: 'ltr' | 'rtl' = 'ltr';
  const setLanguage = (value: string) => {
    const next = normalizeLearningLanguage(value);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* In-memory language still works. */
    }
    updateLanguage(next);
  };
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
  }, [language, direction]);
  const value = useMemo(
    () => ({
      language,
      direction,
      setLanguage,
      t: (text: string) => translateLearning(text, language),
    }),
    [language, direction]
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLearningLanguage() {
  return useContext(LanguageContext);
}

export function LearningLanguageSelector({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useLearningLanguage();
  return (
    <div className={`learning-language ${compact ? 'learning-language--topbar' : ''}`}>
      <label className="learning-language-label">
        <span className="learning-language-icon" aria-hidden="true">🌐</span>
        {!compact && <span>{t('Quiz & Buddy language')}</span>}
        <select
          aria-label={t('Quiz & Buddy language')}
          value={language}
          onChange={event => setLanguage(event.target.value)}
        >
          {learningLanguages.map(([code, title]) => (
            <option value={code} key={code}>
              {title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
