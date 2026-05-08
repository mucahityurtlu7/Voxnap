/**
 * Multilingual stopword & language-aware token utilities for the
 * heuristic on-device summariser.
 *
 * The lists are intentionally compact — we don't need an exhaustive
 * NLTK-grade dictionary. We just need enough to keep TextRank-style
 * keyword scoring from being dominated by closed-class words like
 * "the", "and", "ile", "için", "de la", etc.
 *
 * Adding a new language is a matter of:
 *   1. extending `STOPWORDS` with another `Set<string>`,
 *   2. registering its abbreviation list in `ABBREVIATIONS`,
 *   3. (optional) listing question / action / sentiment cues in
 *      `LEXICON` so the summariser surfaces them in their own buckets.
 *
 * Keep entries lowercase. Lookups always go through `.toLowerCase()`
 * + Unicode-aware `localeCompare` so Turkish dotted/dotless `i` matches
 * the way speakers expect ("İlk" → "ilk").
 */

const en = new Set<string>([
  "a","an","and","are","as","at","be","been","being","but","by","do","does","did","doing",
  "for","from","had","has","have","he","her","here","hers","him","his","how","i","if","in",
  "into","is","it","its","of","off","on","once","only","or","our","ours","out","over","she",
  "so","some","such","than","that","the","their","them","then","there","these","they","this",
  "those","through","to","too","under","until","up","very","was","we","were","what","when",
  "where","which","while","who","whom","why","will","with","would","you","your","yours",
  "yeah","yep","okay","ok","um","uh","like","just","really","actually","kind","sort","sure",
]);

const tr = new Set<string>([
  "acaba","ama","aslında","az","bazı","belki","ben","bence","benden","beni","benim","beri",
  "biri","birkaç","biz","bizden","bize","bizi","bizim","bu","burada","ki","çok","çünkü","da",
  "daha","dahi","de","defa","değil","diye","eğer","en","gibi","göre","halen","hangi","hatta",
  "hem","henüz","hep","hepsi","her","herhangi","herkes","hiç","için","ile","ilgili","ise",
  "işte","itibaren","kadar","karşın","katrilyon","kendi","kendine","kez","ki","kim","kimden",
  "kime","kimi","mı","mi","mu","mü","nasıl","ne","neden","nedenle","nerde","nerede","nereye",
  "niye","niçin","o","olan","olarak","oldu","olduğu","olduğunu","olduklarını","olmadı",
  "olmadığı","olmak","olması","olmayan","olmaz","olsa","olsun","olup","olur","olursa","oluyor",
  "on","ona","ondan","onlar","onlardan","onları","onların","onu","onun","oraya","öyle","pek",
  "rağmen","sadece","sanki","sekiz","seksen","sen","senden","seni","senin","siz","sizden",
  "size","sizi","sizin","son","sonra","şu","şuna","şunda","şundan","şunu","tabii","tüm",
  "üzere","var","vardı","ve","veya","ya","yani","yapacak","yapılan","yapılması","yapıyor",
  "yapmak","yaptı","yaptığı","yaptığını","yedi","yerine","yetmiş","yine","yirmi","yoksa",
  "yüz","zaten","tamam","evet","hayır","yani","işte","şey","öyle","böyle","yani",
]);

const de = new Set<string>([
  "aber","alle","als","also","am","an","auch","auf","aus","bei","bin","bis","bist","da","dann",
  "das","dass","der","den","des","dem","die","ein","eine","einer","eines","einem","einen",
  "er","es","für","ich","im","in","ist","ja","kann","mein","mit","nach","nicht","noch","nur",
  "oder","sein","sie","sind","sonst","über","um","und","uns","unser","von","war","was","wenn",
  "werden","wie","wir","wird","zu","zum","zur",
]);

const es = new Set<string>([
  "a","ante","bajo","cabe","con","contra","de","desde","el","ella","ellas","ellos","en",
  "entre","es","esta","estaba","están","están","fue","ha","han","hasta","la","las","lo","los",
  "más","me","mi","muy","no","nos","nosotros","o","para","pero","por","porque","qué","que",
  "se","si","sí","sin","sobre","su","sus","también","te","tu","tus","un","una","unos","unas",
  "y","ya","yo",
]);

const fr = new Set<string>([
  "à","au","aux","avec","ce","ces","cette","de","des","du","elle","elles","en","est","et",
  "il","ils","je","la","le","les","leur","leurs","ma","mais","mes","mon","ne","nos","notre",
  "nous","on","ou","par","pas","plus","pour","qu","que","qui","sa","sans","ses","si","son",
  "sur","ta","te","tes","ton","tu","un","une","vos","votre","vous","y",
]);

const it = new Set<string>([
  "a","ad","al","alla","alle","ai","agli","anche","ce","che","chi","ci","come","con","cui",
  "da","dal","dalla","dei","degli","del","della","delle","di","dove","e","ed","ha","hanno",
  "ho","i","il","in","io","la","le","lo","loro","ma","me","mi","ne","negli","nel","nella",
  "non","o","per","perché","più","quando","quasi","quello","quei","questa","questo","si",
  "sono","su","sui","sul","sulla","ti","tra","tu","un","una","uno","voi",
]);

/** All known stopword sets keyed by ISO 639-1 code. */
export const STOPWORDS: Record<string, Set<string>> = { en, tr, de, es, fr, it };

/**
 * Per-language abbreviation lists. Used by sentence segmentation so a
 * literal "Dr. Yılmaz" doesn't get split into "Dr" + "Yılmaz". Always
 * stored with the trailing period so a simple suffix-match works.
 */
export const ABBREVIATIONS: Record<string, string[]> = {
  en: ["mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "jr.", "sr.", "vs.", "etc.", "e.g.", "i.e.", "no."],
  tr: ["dr.", "av.", "prof.", "doç.", "yrd.", "sn.", "sa.", "vs.", "v.s.", "vb.", "ör.", "no."],
  de: ["dr.", "prof.", "z.b.", "u.a.", "etc.", "ggf.", "bzw.", "usw."],
  es: ["sr.", "sra.", "dr.", "dra.", "etc.", "ej."],
  fr: ["m.", "mme.", "dr.", "prof.", "etc.", "p.ex."],
  it: ["sig.", "sig.ra", "dr.", "prof.", "etc.", "es."],
};

/**
 * Lexical cues we use to populate the structured summary buckets.
 * Each entry is a list of (case-insensitive) substrings; a sentence is
 * classified into a bucket if any cue matches.
 */
export interface LanguageLexicon {
  /** Cues that mean "someone needs to do something". */
  action: string[];
  /** Cues that mean "we decided / agreed". */
  decision: string[];
  /** Cues that mean a question is being raised (besides the `?` mark). */
  question: string[];
  /** Words that count as positive sentiment evidence. */
  positive: string[];
  /** Words that count as negative sentiment evidence. */
  negative: string[];
  /** Filler / hedging openings to drop from TL;DRs and titles. */
  filler: string[];
}

export const LEXICON: Record<string, LanguageLexicon> = {
  en: {
    action: [
      "todo","action","follow up","follow-up","need to","needs to","let's","let us","i'll",
      "we'll","we will","i will","please","make sure","remember to","next step","action item",
      "should","must","have to","got to","plan to","will be","kindly","by tomorrow","by friday",
    ],
    decision: [
      "decided","we decided","let's go with","we will go with","agreed","we agreed",
      "going with","final decision","settled on","committed to","approved",
    ],
    question: [
      "who","what","when","where","why","how","which","is there","are there","could we",
      "should we","can we","do we","does anyone","any chance",
    ],
    positive: [
      "great","love","awesome","excited","nice","perfect","fantastic","amazing","brilliant",
      "wonderful","good job","well done","working","ship it","like it",
    ],
    negative: [
      "bad","issue","problem","bug","sorry","fail","failed","broken","blocked","blocker",
      "concern","worried","angry","frustrated","not working","doesn't work",
    ],
    filler: [
      "yeah","yep","okay","ok","um","uh","so","well","like","you know","i mean","right",
      "actually","basically","kind of","sort of",
    ],
  },
  tr: {
    action: [
      "yapacağız","yapacağım","yapmalıyız","yapılmalı","halledilmeli","halledelim","halledeceğim",
      "lütfen","gerek var","gerekiyor","planlayalım","planla","hatırlatma","unutma","hallederiz",
      "yarına","cumaya","hafta sonuna","yapalım","ekleyelim","kontrol et","kontrol etmeliyiz",
      "araştır","araştırmamız lazım","görüş","görüşelim","inceleyelim","tamamla","tamamlayalım",
      "todo","yapılacak","aksiyon","aksiyon maddesi","sorumlu",
    ],
    decision: [
      "karar verdik","kararlaştırdık","anlaştık","anlaşıldı","hemfikiriz","onayladık","onaylıyoruz",
      "kabul ettik","gidiyoruz","tercih ettik","seçildi","kesinleşti","sonuçlandırdık",
    ],
    question: [
      "nasıl","neden","niçin","niye","ne zaman","kim","kime","kimden","nerede","nereden",
      "nereye","hangi","hangisi","kaç","kaçta","mı","mi","mu","mü","acaba",
    ],
    positive: [
      "harika","müthiş","sevdim","beğendim","mükemmel","süper","güzel","iyi","tebrikler",
      "başarılı","çalışıyor","sevindim","memnunum","aferin",
    ],
    negative: [
      "kötü","sorun","problem","hata","bozuk","arıza","özür","üzgünüm","başarısız","engel",
      "bloklayıcı","endişe","kaygılı","öfkeli","sinirli","çalışmıyor","yapamıyorum","yapamadım",
    ],
    filler: [
      "şey","yani","işte","tamam","peki","evet","hmm","ee","aa","aslında","yani","bilirsin",
      "demek istediğim","açıkçası","şöyle ki","bir nevi","gibi","öyle","böyle",
    ],
  },
  de: {
    action: [
      "todo","aktion","wir müssen","ich werde","wir werden","bitte","nicht vergessen",
      "lass uns","lasst uns","sollten wir","muss noch","soll noch","planen wir","überprüfen",
    ],
    decision: ["entschieden","wir sind uns einig","abgestimmt","beschlossen","festgelegt","genehmigt"],
    question: ["wer","was","wann","wo","warum","wieso","wie","welche","welcher","welches"],
    positive: ["super","toll","großartig","perfekt","schön","gut","fantastisch","läuft","funktioniert"],
    negative: ["schlecht","problem","fehler","bug","entschuldigung","blockiert","kaputt","sorge"],
    filler: ["also","na ja","äh","ähm","irgendwie","quasi","sozusagen","eigentlich"],
  },
  es: {
    action: ["por hacer","tenemos que","debemos","voy a","vamos a","por favor","no olvidar","planear"],
    decision: ["decidimos","acordamos","aprobado","queda decidido","nos vamos con","elegido"],
    question: ["quién","qué","cuándo","dónde","por qué","cómo","cuál","cuántos"],
    positive: ["genial","perfecto","excelente","bien","funciona","increíble","me encanta"],
    negative: ["mal","problema","error","bug","perdón","fallo","roto","preocupa"],
    filler: ["pues","bueno","eh","este","o sea","tipo","como","la verdad"],
  },
  fr: {
    action: ["à faire","il faut","nous devons","je vais","nous allons","s'il vous plaît","planifions"],
    decision: ["décidé","nous sommes d'accord","approuvé","on part sur","on choisit"],
    question: ["qui","quoi","quand","où","pourquoi","comment","quel","quelle","combien"],
    positive: ["super","génial","parfait","excellent","bien","fonctionne","incroyable","j'adore"],
    negative: ["mauvais","problème","erreur","bug","désolé","cassé","bloqué","inquiet"],
    filler: ["alors","ben","euh","du coup","genre","tu vois","en fait"],
  },
  it: {
    action: ["da fare","dobbiamo","devo","faremo","per favore","non dimenticare","pianifichiamo"],
    decision: ["deciso","abbiamo deciso","d'accordo","approvato","scegliamo","siamo allineati"],
    question: ["chi","cosa","quando","dove","perché","come","quale","quanti"],
    positive: ["fantastico","perfetto","ottimo","bene","funziona","incredibile","mi piace"],
    negative: ["male","problema","errore","bug","scusa","rotto","bloccato","preoccupato"],
    filler: ["allora","insomma","ehm","cioè","tipo","praticamente","sai","in effetti"],
  },
};

/**
 * Tokenise text into lower-cased word forms.
 *
 * We split on Unicode word boundaries instead of plain whitespace so
 * Turkish "İ"/"ı"/"i" stay distinct from punctuation. The fallback
 * regex (`/[\p{L}\p{N}'-]+/gu`) matches any letter/number sequence
 * across the entire Unicode range, covering CJK and Cyrillic too.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ?? [];
}

/**
 * Return `true` if `word` is a stopword in any of the supplied
 * languages. We accept multiple languages because spoken transcripts
 * often code-switch (a Turkish speaker may drop English jargon mid-
 * sentence). Filler words from the language lexicons also count as
 * stopwords for keyword scoring.
 */
export function isStopword(word: string, languages: string[]): boolean {
  const w = word.toLocaleLowerCase();
  for (const lang of languages) {
    const set = STOPWORDS[lang];
    if (set && set.has(w)) return true;
    const lex = LEXICON[lang];
    if (lex && lex.filler.includes(w)) return true;
  }
  return false;
}

/**
 * Detect the most likely language of a transcript chunk.
 *
 * We score each language by counting how many of its stopwords appear
 * in the text — high-frequency function words are the most reliable
 * cheap signal we have. If nothing matches we default to English so
 * downstream code never has to deal with `null`.
 *
 * The detector intentionally biases toward Turkish when the input
 * contains the characters `ç ğ ı İ ş ü`, because those alone are
 * almost always a giveaway and counting stopwords in a 10-word
 * transcript would otherwise tie EN with TR.
 */
export function detectLanguage(text: string): string {
  if (!text || text.trim().length === 0) return "en";

  if (/[çğıİşÇĞŞÜ]/.test(text)) {
    return "tr";
  }

  const tokens = tokenize(text);
  if (tokens.length === 0) return "en";

  let best = "en";
  let bestScore = 0;
  for (const lang of Object.keys(STOPWORDS)) {
    const set = STOPWORDS[lang]!;
    let hits = 0;
    for (const t of tokens) {
      if (set.has(t)) hits += 1;
    }
    if (hits > bestScore) {
      bestScore = hits;
      best = lang;
    }
  }
  return best;
}

/**
 * Strip a sentence of leading filler words ("şey, yani,", "yeah, so,").
 * Used to clean TL;DRs and auto-suggested titles.
 */
export function stripFiller(sentence: string, language: string): string {
  const lex = LEXICON[language];
  if (!lex) return sentence.trim();

  let out = sentence.trim();
  // Repeatedly peel off filler tokens from the front. Cap at 4 passes
  // so we don't loop forever on pathological inputs.
  for (let i = 0; i < 4; i++) {
    const lower = out.toLocaleLowerCase();
    const matched = lex.filler
      .slice()
      .sort((a, b) => b.length - a.length) // longest match first
      .find((f) => lower.startsWith(`${f} `) || lower.startsWith(`${f},`));
    if (!matched) break;
    out = out.slice(matched.length).replace(/^[\s,;:.\-—–]+/, "");
  }
  // Capitalise first letter so the result reads like a real sentence.
  if (out.length > 0) {
    out = out.charAt(0).toLocaleUpperCase() + out.slice(1);
  }
  return out;
}
