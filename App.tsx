import { useState, useEffect, useRef } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { supabase } from './supabase';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
type Page = 'auth' | 'home' | 'practice-subjects' | 'learn-subjects' | 'quiz' | 'results' | 'learn-topic' | 'progress' | 'blynk-customize' | 'multi-quiz-hub' | 'multi-quiz-lobby' | 'multi-quiz-game' | 'account' | 'search-accounts';
type Subject = 'math' | 'language' | 'science' | 'social';

interface User { id: string; name: string; email: string; provider: string; joined: string; coins: number; }
interface QuizResult { id: string; subject: Subject; score: number; total: number; percentage: number; timeUsed: number; date: string; }
interface Question { id: number; question: string; options: [string, string, string]; correct: 0 | 1 | 2; explanation: string; image?: string; }

interface NoteTopic {
  id: string; title: string; emoji: string; content: string;
  videoQuery: string;
}

// Blynk customization
interface BlynkStyle {
  color: string; eyes: string; mouth: string; outfitType: string; outfitColor: string; hat: string; accessory: string;
}
const DEFAULT_BLYNK: BlynkStyle = { color: '#c49a6c', eyes: 'Normal', mouth: 'Smile', outfitType: 'Hoodie', outfitColor: '#ef4444', hat: 'None', accessory: 'None' };
const BLYNK_OPTIONS = {
  color: ['#c49a6c','#a87850','#f5d0a0','#ffe4b5','#8b5cf6','#c084fc','#22c55e','#4ade80','#ef4444','#f87171','#3b82f6','#60a5fa','#f472b6','#facc15','#ffffff','#94a3b8'],
  eyes: ['Normal','Happy','Sad','Mad','Bored','Wink','Surprised','Closed','Derp','Hearts'],
  mouth: ['Smile','Big Smile','Tongue','Wavy','Frown','Straight','Open','Smirk','Teeth','Ooo','Cat','Side'],
  outfitType: ['Hoodie','T-Shirt','Polo','Overalls','Cape','Jacket','Dress','Tank Top','Turtleneck','Suit'],
  outfitColor: ['#ef4444','#dc2626','#3b82f6','#1d4ed8','#22c55e','#15803d','#eab308','#a855f7','#78350f','#1f2937','#f472b6','#06b6d4','#f97316','#ffffff','#6b7280','#84cc16'],
  hat: ['None','Crown','Cat Beanie','Dog Beanie','Safari Hat','Leaf Sprout','Top Hat','Santa Cap','Wizard Hat','Party Hat','Baseball Cap','Halo'],
  accessory: ['None','Blush','Shades','Nerdy Glasses','Heart Glasses','Gold Chain','Bowtie','Freckles','Scar','Monocle']
};

// Multiplayer quiz
interface MPPlayer { id: string; name: string; blynk: BlynkStyle; score: number; answers: Record<number, number>; }
interface MPRoom {
  code: string; creator: string; players: MPPlayer[]; subject: Subject; questions: Question[];
  status: 'waiting' | 'playing' | 'finished'; currentQ: number; questionStartTime: number;
  timePerQuestion: number;          // seconds per question (host-configurable)
  teacherMode: boolean;             // host gets extra controls but still plays
  showLeaderboard: boolean;         // mid-quiz leaderboard screen flag
}

interface MPSession {
  role: 'host' | 'guest';
  roomCode: string;
  myPeerId: string;
}

type MPMessage =
  | { type: 'join'; name: string; blynk: BlynkStyle; peerId: string }
  | { type: 'room_state'; room: MPRoom }
  | { type: 'submit_answer'; peerId: string; answer: number }
  | { type: 'next_question' }
  | { type: 'start_game' }
  | { type: 'leave'; peerId: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LOCAL STORAGE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function saveUser(user: User | null) {
  if (user) localStorage.setItem('cpea_user', JSON.stringify(user));
  else localStorage.removeItem('cpea_user');
}
function loadUser(): User | null {
  try {
    const u = JSON.parse(localStorage.getItem('cpea_user') || 'null');
    if (u && u.coins === undefined) u.coins = 0; // migrate old saves
    return u;
  } catch { return null; }
}
function saveResults(results: QuizResult[]) { localStorage.setItem('cpea_results', JSON.stringify(results)); }
function loadResults(): QuizResult[] {
  try { return JSON.parse(localStorage.getItem('cpea_results') || '[]'); } catch { return []; }
}

interface PublicAccount {
  id: string; name: string; email: string; coins: number; blynk: BlynkStyle; joined: string;
  testsTaken: number; bestScore: number; avgScore: number;
}

const ACCOUNT_CLOUD_URL = 'https://mantledb.sh/v2/cpea-grade56-blynk-directory/accounts';

function loadAccounts(): PublicAccount[] {
  try { return JSON.parse(localStorage.getItem('cpea_accounts') || '[]'); } catch { return []; }
}

async function loadCloudAccounts(): Promise<PublicAccount[]> {
  try {
    const res = await fetch(ACCOUNT_CLOUD_URL, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.accounts) ? data.accounts : [];
  } catch {
    return [];
  }
}

async function saveCloudAccount(profile: PublicAccount) {
  try {
    const cloudAccounts = await loadCloudAccounts();
    const idx = cloudAccounts.findIndex(a => a.id === profile.id || (profile.email && a.email === profile.email));
    if (idx >= 0) cloudAccounts[idx] = profile;
    else cloudAccounts.push(profile);
    await fetch(ACCOUNT_CLOUD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts: cloudAccounts.slice(-500), updatedAt: Date.now() }),
    });
  } catch (err) {
    console.warn('Global account directory sync failed:', err);
  }
}

function saveAccountProfile(user: User, blynk: BlynkStyle, results: QuizResult[]) {
  const accounts = loadAccounts();
  const testsTaken = results.length;
  const bestScore = testsTaken ? Math.max(...results.map(r => r.percentage)) : 0;
  const avgScore = testsTaken ? Math.round(results.reduce((a, r) => a + r.percentage, 0) / testsTaken) : 0;
  const profile: PublicAccount = { id: user.id, name: user.name, email: user.email, coins: user.coins, blynk, joined: user.joined, testsTaken, bestScore, avgScore };
  const idx = accounts.findIndex(a => a.id === user.id || (user.email && a.email === user.email));
  if (idx >= 0) accounts[idx] = profile; else accounts.push(profile);
  localStorage.setItem('cpea_accounts', JSON.stringify(accounts));
}

async function syncAccountProfile(user: User, blynk: BlynkStyle, results: QuizResult[]) {
  saveAccountProfile(user, blynk, results);
  const testsTaken = results.length;
  const bestScore = testsTaken ? Math.max(...results.map(r => r.percentage)) : 0;
  const avgScore = testsTaken ? Math.round(results.reduce((a, r) => a + r.percentage, 0) / testsTaken) : 0;
  const publicProfile: PublicAccount = { id: user.id, name: user.name, email: user.email, coins: user.coins, blynk, joined: user.joined, testsTaken, bestScore, avgScore };
  saveCloudAccount(publicProfile);

  if (!supabase || user.id.startsWith('guest-') || user.id.startsWith('local-')) return;
  const { error } = await supabase.from('profiles').upsert({
    id: user.id,
    name: user.name,
    email: user.email,
    coins: user.coins,
    blynk,
    tests_taken: testsTaken,
    best_score: bestScore,
    avg_score: avgScore,
  });
  if (error) console.warn('Account cloud sync failed:', error.message);
}

function blurEmail(email: string) {
  if (!email) return 'Guest Account';
  const [name, domain] = email.split('@');
  if (!domain) return '*'.repeat(Math.max(6, email.length));
  return `${'*'.repeat(Math.max(4, name.length))}@${'*'.repeat(Math.max(4, domain.length))}`;
}

function saveBlynk(b: BlynkStyle) { localStorage.setItem('cpea_blynk', JSON.stringify(b)); }
function loadBlynk(): BlynkStyle {
  try { return JSON.parse(localStorage.getItem('cpea_blynk') || 'null') || DEFAULT_BLYNK; } catch { return DEFAULT_BLYNK; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NOTES DATA (expanded CPEA topics + video queries)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const notesData: Record<Subject, NoteTopic[]> = {
  math: [
    { id: 'place-value', title: 'Place Value & Number Sense', emoji: '🔢',
      videoQuery: 'place value for kids primary school',
      content: `**Place Value** — Every digit in a number has a value based on its position.
Example: In 7,685 → 7 thousands, 6 hundreds, 8 tens, 5 ones.

**Comparing Numbers**: Use >, <, = symbols. 5,432 > 3,999

**Rounding**: To nearest 10, 100, 1000. 4,567 → 4,600 (nearest 100)

**Prime Numbers**: Numbers with exactly 2 factors (1 and itself).
2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31... (1 is NOT prime!)

**Composite Numbers**: Have MORE than 2 factors. 4, 6, 8, 9, 10, 12...

**HCF (GCF)**: The biggest number that divides into all given numbers.
Example: HCF of 8, 16, 20 = 4

**LCM**: The smallest number that all given numbers divide into.
Example: LCM of 4 and 10 = 20` },
    { id: 'fractions', title: 'Fractions, Decimals & Percentages', emoji: '🥧',
      videoQuery: 'fractions decimals percentages primary school',
      content: `**Adding Fractions**: Find common denominator → add numerators → simplify.
Example: 2/3 + 1/6 = 4/6 + 1/6 = 5/6

**Multiplying Fractions**: Top × top, bottom × bottom. 1/2 × 2/3 = 2/6 = 1/3

**Dividing Fractions**: Flip the second and multiply. 1/2 ÷ 1/4 = 1/2 × 4/1 = 2

**Key Conversions**:
• 1/2 = 0.5 = 50%    • 1/4 = 0.25 = 25%
• 3/4 = 0.75 = 75%   • 1/5 = 0.2 = 20%
• 1/10 = 0.1 = 10%   • 3/8 = 0.375 = 37.5%

**Fraction → %**: Multiply by 100. 3/5 × 100 = 60%
**% → Fraction**: Write over 100, simplify. 45% = 45/100 = 9/20` },
    { id: 'geometry', title: 'Geometry & Shapes', emoji: '📐',
      videoQuery: 'geometry shapes 2D 3D primary school',
      content: `**2D Shapes**: Square (4 equal sides, 4 right angles), Rectangle, Triangle (3 sides, angles = 180°), Circle, Pentagon (5), Hexagon (6)

**Triangles**: Equilateral (all equal), Isosceles (2 equal), Scalene (all different)

**Angles**: Acute (<90°), Right (90°), Obtuse (90°-180°), Straight (180°), Reflex (>180°)

**Lines**: Parallel (never meet), Perpendicular (meet at 90°), Intersecting

**Perimeter**: Add all sides. Rectangle = 2(L+W)
**Area**: Rectangle = L×W, Square = side², Triangle = ½×b×h

**3D Shapes**: Cube (6 faces, 12 edges, 8 vertices), Cuboid, Cylinder, Sphere, Triangular Prism (5 faces, 9 edges, 6 vertices)` },
    { id: 'measurement', title: 'Measurement & Conversions', emoji: '📏',
      videoQuery: 'metric measurement conversions length mass capacity primary',
      content: `**Metric Units**:
• Length: 1 km = 1000 m, 1 m = 100 cm, 1 cm = 10 mm
• Mass: 1 kg = 1000 g, 1 tonne = 1000 kg
• Capacity: 1 L = 1000 mL

**Time**: 1 hour = 60 min, 1 min = 60 sec, 1 day = 24 hr

**24-Hour Time**: 2:30 PM = 14:30, 7:00 PM = 19:00

**Perimeter**: Distance around. P = 2(L+W) for rectangle.
**Area of Rectangle**: L × W. Square: side². Triangle: ½bh.
**Volume of Cube**: side³. Cuboid: L×W×H.

**Speed = Distance ÷ Time**` },
    { id: 'ratio-proportion', title: 'Ratio, Proportion & Money', emoji: '💰',
      videoQuery: 'ratio proportion word problems primary school',
      content: `**Ratios**: Compare quantities. 60:90 simplifies to 2:3 (÷30).

**Sharing in Ratio**: Share $40 in 3:5. Total parts = 8. Each = $5. Shares: $15 and $25.

**Profit & Loss**:
• Profit = Selling Price − Cost Price
• Profit % = (Profit ÷ Cost Price) × 100

**Percentage Change**: (New − Old) ÷ Old × 100

**Discount**: 10% off $45 = $45 − $4.50 = $40.50` },
    { id: 'data-stats', title: 'Data Handling & Graphs', emoji: '📊',
      videoQuery: 'mean median mode bar graph primary school math',
      content: `**Mean**: Sum ÷ count. (5+8+12+7+8) ÷ 5 = 8
**Median**: Middle number when ordered. 3,7,8,12,15 → 8
**Mode**: Most frequent. 4,7,7,2,9,7,5 → Mode = 7
**Range**: Largest − Smallest. 20−5 = 15

**Graph Types**: Bar graphs, line graphs, pie charts, pictographs.
Read axes carefully — check what each unit represents!` },
    { id: 'problem-solving', title: 'Word Problems & Reasoning', emoji: '🧩',
      videoQuery: 'math word problems problem solving strategies kids',
      content: `**Steps to Solve Word Problems**:
1. Read carefully — underline key numbers
2. Identify what's being asked
3. Choose the right operation (+, −, ×, ÷)
4. Solve step by step
5. Check your answer makes sense

**Key words**: "Total" = add, "Difference" = subtract, "Product" = multiply, "Share/Each" = divide

**BODMAS/PEMDAS**: Brackets, Orders, Division, Multiplication, Addition, Subtraction` },
  ],
  language: [
    { id: 'parts-speech', title: 'Parts of Speech', emoji: '📝',
      videoQuery: 'parts of speech nouns verbs adjectives kids',
      content: `**Nouns**: Naming words — common (dog), proper (Barbados), abstract (happiness)
**Pronouns**: I, you, he, she, it, we, they, me, him, her, my, your
**Verbs**: Action words. Tenses: past (ran), present (runs), future (will run)
**Adjectives**: Describe nouns. The RED car, the TALL tree
**Adverbs**: Describe verbs (often -ly). She ran QUICKLY
**Prepositions**: Position/time — on, in, at, under, between
**Conjunctions**: Join — and, but, or, because, although
**Interjections**: Emotion — Wow!, Oh!, Hey!` },
    { id: 'spelling', title: 'Spelling Rules & Common Mistakes', emoji: '✍️',
      videoQuery: 'spelling rules for kids i before e',
      content: `**"i before e except after c"**: achieve, receive, deceive (BUT: weird, seize)

**Plurals**: tomato→tomatoes (add -es), photo→photos (just -s)

**Adding -ing**: make→making (drop e), run→running (double), play→playing

**Commonly Misspelled**: beautiful, because (Big Elephants Can Always Understand Small Elephants), friend, receive, necessary (one c, two s), separate (sep-A-RAT-e)` },
    { id: 'punctuation', title: 'Punctuation & Capitalization', emoji: '❗',
      videoQuery: 'punctuation rules capitalization kids primary school',
      content: `**Capital Letters**: Start of sentence, proper nouns, titles, "I", days/months

**Commas**: Lists (pencils, crayons, and books), after intro words

**Quotation Marks**: "Hello," said Mary. Punctuation INSIDE quotes!

**Apostrophes**: Contractions (don't, can't), possession (boy's ball). NOT plurals!

**Semicolon (;)**: Joins related sentences
**Colon (:)**: Introduces a list` },
    { id: 'sentence-structure', title: 'Sentence Types & Grammar', emoji: '📋',
      videoQuery: 'types of sentences declarative interrogative imperative exclamatory',
      content: `**4 Types**: Declarative (statement), Interrogative (question), Imperative (command), Exclamatory (emotion!)

**Subject-Verb Agreement**: Singular subject → singular verb. The dog barks. The dogs bark.

**Active vs Passive**: Active: The boy kicked the ball. Passive: The ball was kicked by the boy.

**Neither...nor / Either...or**: Verb agrees with nearest subject. Neither the boys nor their sister PLAYS tennis.` },
    { id: 'comprehension', title: 'Reading Comprehension', emoji: '📖',
      videoQuery: 'reading comprehension tips strategies primary school',
      content: `**Tips**: Read questions FIRST. Read passage twice. Underline key words.

**Figurative Language**: Simile (like/as), Metaphor (direct), Personification (human qualities), Alliteration (same sound), Hyperbole (exaggeration)

**Story Elements**: Setting, Characters, Plot, Theme, Conflict` },
    { id: 'vocabulary', title: 'Vocabulary & Word Meaning', emoji: '📚',
      videoQuery: 'vocabulary building synonyms antonyms kids',
      content: `**Synonyms** (same meaning): big/large, small/tiny, happy/joyful, sad/unhappy, fast/quick

**Antonyms** (opposite): hot/cold, big/small, happy/sad, brave/cowardly, ancient/modern

**Prefixes**: un- (not), re- (again), pre- (before), mis- (wrongly)
**Suffixes**: -less (without), -ful (full of), -able (can be), -ly (in that way)

**Root words**: unhappy → happy, misspelling → spell, replay → play` },
    { id: 'writing', title: 'Writing Skills & Composition', emoji: '✏️',
      videoQuery: 'how to write a paragraph narrative writing kids',
      content: `**Paragraph Structure**: Topic sentence → supporting details → concluding sentence

**Types of Writing**: Narrative (story), Descriptive (describe), Persuasive (convince), Expository (explain)

**Planning**: Brainstorm → organize ideas → draft → revise → final copy

**Connectives**: First, then, next, after, finally, however, therefore, meanwhile` },
  ],
  science: [
    { id: 'living-things', title: 'Living Things & Classification', emoji: '🌿',
      videoQuery: 'characteristics of living things MRS GREN for kids',
      content: `**MRS GREN**: Movement, Respiration, Sensitivity, Growth, Reproduction, Excretion, Nutrition

**Animals**: Mammals (warm-blooded, fur, milk), Birds (feathers, eggs), Reptiles (scales, cold-blooded), Amphibians (water+land), Fish (gills, scales), Insects (6 legs, 3 body parts)

**Plants**: Roots (absorb water), Stem (support), Leaves (photosynthesis), Flower (reproduction)

**Food Chains**: Producer → Primary Consumer → Secondary Consumer
Example: Grass → Rabbit → Lion` },
    { id: 'human-body', title: 'The Human Body & Health', emoji: '🫀',
      videoQuery: 'human body organs systems for kids primary school',
      content: `**Major Organs**: Heart (pumps blood), Lungs (gas exchange), Brain (control), Stomach (digestion), Kidneys (filter blood), Liver (process nutrients), Skin (largest organ)

**Blood**: Red cells (carry oxygen), White cells (fight disease), Platelets (clotting)

**Digestive System**: Mouth → Oesophagus → Stomach → Small Intestine → Large Intestine

**Circulatory**: Arteries (away from heart), Veins (toward heart), Capillaries (tiny vessels)

**Sense Organs**: Eye (sight), Ear (hearing+balance), Nose (smell), Tongue (taste), Skin (touch)

**Health**: Balanced diet, exercise, sleep, wash hands, drink water` },
    { id: 'energy-forces', title: 'Energy, Forces & Motion', emoji: '⚡',
      videoQuery: 'types of energy forces motion simple machines kids',
      content: `**Energy Types**: Chemical (food, batteries), Kinetic (movement), Potential (stored), Light, Sound, Heat, Electrical

**Forces**: Gravity (pulls down), Friction (opposes motion), Magnetism (attracts/repels)

**Simple Machines**: Lever, Pulley, Inclined Plane, Wedge, Screw, Wheel & Axle

**Sound**: Travels as vibrations. Fastest in solids, slowest in gases.
**Light**: Travels straight. Transparent (glass), Translucent (wax paper), Opaque (wood)

**Conductors**: Copper, iron. **Insulators**: Rubber, plastic, wood` },
    { id: 'earth-space', title: 'Earth, Weather & Space', emoji: '🌍',
      videoQuery: 'solar system planets earth rotation day night for kids',
      content: `**Solar System**: Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune

**Earth's Movements**: Rotation (day/night, 24 hrs), Revolution (seasons, 365 days)

**The Moon**: Natural satellite, reflects sunlight, causes tides

**Water Cycle**: Evaporation → Condensation → Precipitation → Collection

**Weather Tools**: Thermometer (temp), Rain gauge (rainfall), Barometer (pressure), Anemometer (wind)

**Rocks**: Igneous (from lava), Sedimentary (layers), Metamorphic (heat+pressure)` },
    { id: 'environment', title: 'Environment & Conservation', emoji: '🌱',
      videoQuery: 'environment conservation reduce reuse recycle for kids',
      content: `**Natural Resources**: Renewable (solar, wind, water) vs Non-renewable (petroleum, coal)

**Pollution**: Air (burning, exhaust), Water (dumping), Land (littering)

**The 3 R's**: Reduce, Reuse, Recycle

**Deforestation**: Soil erosion, habitat loss, less oxygen

**Biodiversity**: Variety of species — high = healthy ecosystem

**Hurricanes**: Form over warm ocean, have an eye (calm centre), June-November season` },
    { id: 'matter-materials', title: 'Matter & Materials', emoji: '🧪',
      videoQuery: 'states of matter solid liquid gas for kids primary science',
      content: `**States of Matter**: Solid (fixed shape), Liquid (takes container shape), Gas (spreads out)

**Changes**: Melting (solid→liquid), Freezing (liquid→solid), Evaporation (liquid→gas), Condensation (gas→liquid)

**Water**: Boils at 100°C, freezes at 0°C

**Physical vs Chemical Change**: Physical = reversible (melting ice), Chemical = new substance (burning wood)

**Mixtures**: Can be separated — filtration (sand+water), evaporation (salt+water)` },
    { id: 'plants-photosynthesis', title: 'Plants & Photosynthesis', emoji: '🌻',
      videoQuery: 'photosynthesis for kids how plants make food',
      content: `**Photosynthesis**: Plants use sunlight + CO₂ + water → glucose + oxygen

**Plant Parts**: Roots (absorb water), Stem (carry water/food), Leaves (make food — chlorophyll captures sunlight), Flower (reproduction)

**Pollination**: Transfer of pollen from stamen (male) to pistil (female)

**Germination**: Seed sprouts and grows into a new plant

**Seed Dispersal**: Wind, water, animals, explosion` },
  ],
  social: [
    { id: 'caribbean-geo', title: 'Caribbean Geography', emoji: '🗺️',
      videoQuery: 'Caribbean geography islands map for kids',
      content: `**Location**: Between North & South America, Atlantic Ocean

**Island Groups**: Greater Antilles (Cuba, Jamaica, Hispaniola, Puerto Rico), Lesser Antilles (Barbados, St. Lucia, Grenada...), Lucayan Archipelago (Bahamas)

**Island Types**: Volcanic (St. Vincent, St. Lucia), Coral limestone (Barbados, Antigua), Continental (Trinidad)

**Climate**: Tropical — warm year-round. Wet (June-Nov), Dry (Dec-May)

**Capital Cities**: Bridgetown (Barbados), Kingston (Jamaica), Port of Spain (Trinidad), Castries (St. Lucia)` },
    { id: 'indigenous', title: 'Indigenous Peoples of the Caribbean', emoji: '🏹',
      videoQuery: 'Arawaks Tainos Caribs Kalinago indigenous Caribbean history',
      content: `**Arawaks (Tainos)**: Peaceful farmers, lived in Greater Antilles, grew cassava and corn, greeted Columbus (1492)

**Caribs (Kalinagos)**: Fierce warriors, skilled canoe builders, Lesser Antilles, "Caribbean" named after them

**Fate**: Disease, conflict, enslavement. Kalinago communities still exist in Dominica & St. Vincent!

**Contributions**: Words (hurricane, hammock, barbecue, canoe), foods (cassava, sweet potato), fishing/farming techniques` },
    { id: 'slavery-emancipation', title: 'Slavery & Emancipation', emoji: '⛓️',
      videoQuery: 'transatlantic slave trade Caribbean emancipation history for kids',
      content: `**Transatlantic Slave Trade**: Millions of Africans forcibly brought to work on plantations

**Plantation System**: Large farms (mainly sugar), enslaved Africans did all the hard labour

**Resistance**: Running away (Maroons), rebellions, preserving African culture

**Emancipation**: 1834 (abolished), 1838 (full freedom — August 1 = Emancipation Day!)

**After**: Formerly enslaved left plantations, started villages. Indentured labourers arrived from India.

**Key Dates**: 1492 (Columbus), 1834/1838 (Emancipation), August 1 (Emancipation Day)` },
    { id: 'government', title: 'Government & Citizenship', emoji: '🏛️',
      videoQuery: 'three branches of government for kids citizenship',
      content: `**Three Branches**: Executive (PM, Cabinet — enforces laws), Legislative (Parliament — makes laws), Judicial (courts — interprets laws)

**Democracy**: Citizens elect representatives

**Rights**: Free speech, religion, education, vote, fair trial
**Responsibilities**: Vote, pay taxes, obey law, serve jury, protect environment

**Constitution**: Supreme law of the country

**Opposition**: Political party that lost — checks and questions government` },
    { id: 'caribbean-culture', title: 'Caribbean Culture & Festivals', emoji: '🎭',
      videoQuery: 'Caribbean culture carnival reggae steelpan festivals for kids',
      content: `**Culture Mix**: African + European + Indigenous + Indian influences

**Music**: Reggae (Jamaica/Bob Marley), Calypso/Soca (Trinidad), Steelpan (Trinidad — only acoustic instrument invented in 20th century!), Dancehall, Zouk

**Festivals**: Carnival, Crop Over (Barbados), Divali (Hindu), Emancipation Day (Aug 1), Independence Days

**Food**: Provisions (yam, sweet potato, dasheen), rice & peas, roti, pelau, jerk chicken

**Sports**: Cricket (most popular!), Athletics, Football, Netball` },
    { id: 'caricom', title: 'CARICOM & Regional Integration', emoji: '🤝',
      videoQuery: 'CARICOM Caribbean Community explained for kids',
      content: `**CARICOM**: Formed 1973, Treaty of Chaguaramas. HQ: Georgetown, Guyana.

**Purpose**: Trade between members, coordinate foreign policy, education/health programs, disaster management

**OECS**: Smaller group — Antigua, Dominica, Grenada, Montserrat, St. Kitts & Nevis, St. Lucia, St. Vincent. Shared currency: EC Dollar.

**Benefits**: Stronger together, shared resources, unified voice, free movement

**Challenges**: Different currencies/laws, distance between islands, competition` },
    { id: 'independence', title: 'Independence & National Identity', emoji: '🇧🇧',
      videoQuery: 'Caribbean independence history national symbols for kids',
      content: `**Barbados Independence**: November 30, 1966. Became a Republic in 2021.

**National Symbols**: Flag, anthem, coat of arms, pledge, national flower/tree/bird

**Other Independence Dates**: Jamaica (Aug 6, 1962), Trinidad (Aug 31, 1962), Guyana (May 26, 1966)

**Republic vs Constitutional Monarchy**: Republic has President as head of state. Monarchy has King/Queen.

**Commonwealth**: Association of former British colonies — cooperation, shared history` },
    { id: 'economics', title: 'Basic Economics & Trade', emoji: '💼',
      videoQuery: 'economics for kids trade imports exports primary school',
      content: `**Imports**: Goods bought FROM other countries
**Exports**: Goods sold TO other countries

**Primary Industry**: Extracting raw materials (farming, fishing, mining)
**Secondary Industry**: Manufacturing (making sugar from sugarcane)
**Tertiary/Service Industry**: Services (banking, tourism, education)

**Tourism**: Major Caribbean industry — creates jobs, brings foreign currency

**Taxes**: Money citizens pay to government for public services (schools, roads, hospitals)` },
  ],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUESTION BANKS (same as before, just condensed for space)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const mathQuestions: Question[] = [
  { id: 1, question: "What is the value of the 6 in 7 685?", options: ["60", "600", "6 000"], correct: 1, explanation: "The 6 is in the hundreds place: 6 × 100 = 600." },
  { id: 2, question: "Which of the following is a composite number?", options: ["19", "30", "47"], correct: 1, explanation: "30 has factors 1,2,3,5,6,10,15,30 — more than 2 factors." },
  { id: 3, question: "A prime number greater than 21 and less than 28 is", options: ["23", "25", "27"], correct: 0, explanation: "23 is prime. 25=5×5, 27=3×9 are composite." },
  { id: 4, question: "The H.C.F. of 8, 16 and 20 is", options: ["2", "4", "8"], correct: 1, explanation: "Common factors: 1, 2, 4. Highest = 4." },
  { id: 5, question: "Which statement is TRUE?", options: ["6 × 6 > 9 × 4", "3 × 8 > 6 × 10", "2 × 7 > 15 − 3"], correct: 2, explanation: "36>36 false, 24>60 false, 14>12 TRUE." },
  { id: 6, question: "The difference between two numbers is 85. The smaller is 237. What is the larger?", options: ["152", "312", "322"], correct: 2, explanation: "237 + 85 = 322." },
  { id: 7, question: "Light M flashes every 4 min. Light N flashes every 10 min. Flashed together at 6:00 a.m. Next time?", options: ["6:10 a.m.", "6:14 a.m.", "6:20 a.m."], correct: 2, explanation: "LCM of 4 and 10 = 20 min. 6:00 + 20 = 6:20 a.m." },
  { id: 8, question: "What fraction of an hour is 45 minutes?", options: ["1/4", "3/4", "4/3"], correct: 1, explanation: "45/60 = 3/4." },
  { id: 9, question: "A unit fraction has a", options: ["value of 1", "numerator of 1", "denominator of 1"], correct: 1, explanation: "Unit fraction: numerator = 1 (e.g., 1/2, 1/3)." },
  { id: 10, question: "John chose a number, doubled it and subtracted 5. The result was 45. What number?", options: ["20", "25", "50"], correct: 1, explanation: "2x − 5 = 45 → 2x = 50 → x = 25." },
  { id: 11, question: "Sammy got 3 out of 5 correct. His percentage was", options: ["25%", "40%", "60%"], correct: 2, explanation: "3/5 = 0.6 = 60%." },
  { id: 12, question: "If 20% of a number is 8, what is the number?", options: ["40", "60", "80"], correct: 0, explanation: "0.2x = 8 → x = 40." },
  { id: 13, question: "A school has 60 girls and 90 boys. Ratio of girls to boys is", options: ["2:3", "3:2", "9:6"], correct: 0, explanation: "60:90 ÷ 30 = 2:3." },
  { id: 14, question: "A quadrilateral with four equal sides and four right angles is", options: ["square", "rhombus", "rectangle"], correct: 0, explanation: "Only square has both 4 equal sides AND 4 right angles." },
  { id: 15, question: "What is 7:30 p.m. in 24-hour format?", options: ["19:30 hrs", "18:30 hrs", "21:30 hrs"], correct: 0, explanation: "7 + 12 = 19:30 hrs." },
  { id: 16, question: "An angle of 135° is described as", options: ["reflex", "obtuse", "straight"], correct: 1, explanation: "Obtuse: between 90° and 180°." },
  { id: 17, question: "The metric unit of length is the", options: ["litre", "metre", "kilogram"], correct: 1, explanation: "Metre = length. Litre = capacity. Kilogram = mass." },
  { id: 18, question: "A ribbon 7.62 m long cut into 6 equal pieces. Length of each?", options: ["1.27 m", "13.62 m", "45.72 m"], correct: 0, explanation: "7.62 ÷ 6 = 1.27 m." },
  { id: 19, question: "Which set is LARGEST to smallest?", options: ["0.7, 0.07, 0.007, 7", "7, 0.07, 0.7, 0.007", "7, 0.7, 0.07, 0.007"], correct: 2, explanation: "7 > 0.7 > 0.07 > 0.007." },
  { id: 20, question: "A motorcycle at 30 km/h. Minutes to travel 20 km?", options: ["25 min", "40 min", "50 min"], correct: 1, explanation: "Time = 20/30 hr = 2/3 hr = 40 min." },
  { id: 21, question: "Bought 20 lbs salt fish for $160. Sold at $10/lb. Profit %?", options: ["20%", "25%", "80%"], correct: 1, explanation: "SP = $200. Profit = $40. % = 40/160 × 100 = 25%." },
  { id: 22, question: "What time is 40 minutes after 3:25 p.m.?", options: ["2:45 p.m.", "4:00 p.m.", "4:05 p.m."], correct: 2, explanation: "3:25 + 40 = 4:05 p.m." },
  { id: 23, question: "Look at the triangle. Two sides are 10 cm and base is 12 cm. It is:", options: ["scalene", "isosceles", "equilateral"], correct: 1, explanation: "Two equal sides = isosceles.", image: "/images/triangle.png" },
  { id: 24, question: "LCM of 6 and 8 is", options: ["24", "48", "12"], correct: 0, explanation: "Multiples of 6: 6,12,18,24. Of 8: 8,16,24. LCM = 24." },
  { id: 25, question: "Express 3/8 as a decimal.", options: ["0.375", "0.38", "3.8"], correct: 0, explanation: "3 ÷ 8 = 0.375." },
  { id: 26, question: "What is 15% of 240?", options: ["36", "24", "48"], correct: 0, explanation: "15/100 × 240 = 36." },
  { id: 27, question: "Perimeter of rectangle length 12 cm, width 5 cm?", options: ["34 cm", "60 cm", "17 cm"], correct: 0, explanation: "2(12+5) = 34 cm." },
  { id: 28, question: "Area of square side 9 cm?", options: ["36 cm²", "81 cm²", "18 cm²"], correct: 1, explanation: "9 × 9 = 81 cm²." },
  { id: 29, question: "How many faces does a cuboid have?", options: ["4", "6", "8"], correct: 1, explanation: "6 rectangular faces." },
  { id: 30, question: "What is 2/3 + 1/6?", options: ["3/9", "5/6", "3/6"], correct: 1, explanation: "2/3 = 4/6. 4/6 + 1/6 = 5/6." },
  { id: 31, question: "Convert 0.45 to simplest fraction.", options: ["45/10", "9/20", "4/5"], correct: 1, explanation: "45/100 = 9/20." },
  { id: 32, question: "Book $45, 10% discount. Sale price?", options: ["$40.50", "$35", "$41"], correct: 0, explanation: "10% of $45 = $4.50. $45 − $4.50 = $40.50." },
  { id: 33, question: "Volume of cube side 3 cm?", options: ["9 cm³", "18 cm³", "27 cm³"], correct: 2, explanation: "3 × 3 × 3 = 27 cm³." },
  { id: 34, question: "How many mL in 2.5 litres?", options: ["250 mL", "2 500 mL", "25 000 mL"], correct: 1, explanation: "2.5 × 1000 = 2500 mL." },
  { id: 35, question: "Mean of 5, 8, 12, 7, 8?", options: ["7", "8", "9"], correct: 1, explanation: "Sum = 40. 40/5 = 8." },
  { id: 36, question: "Circle diameter 14 cm. Radius?", options: ["28 cm", "7 cm", "14 cm"], correct: 1, explanation: "Radius = 14 ÷ 2 = 7 cm." },
  { id: 37, question: "What is ¾ of 120?", options: ["80", "90", "100"], correct: 1, explanation: "¾ × 120 = 90." },
  { id: 38, question: "Mode of 4, 7, 7, 2, 9, 7, 5?", options: ["4", "5", "7"], correct: 2, explanation: "7 appears 3 times (most)." },
  { id: 39, question: "A right angle measures", options: ["45°", "90°", "180°"], correct: 1, explanation: "Exactly 90°." },
  { id: 40, question: "How many grams in 2.5 kg?", options: ["250 g", "2 500 g", "25 000 g"], correct: 1, explanation: "2.5 × 1000 = 2500 g." },
  { id: 41, question: "Round 4 567 to nearest hundred.", options: ["4 500", "4 600", "4 570"], correct: 1, explanation: "Tens digit 6 ≥ 5, round up." },
  { id: 42, question: "Next: 5, 9, 13, 17, ...?", options: ["19", "20", "21"], correct: 2, explanation: "+4 pattern. 17 + 4 = 21." },
  { id: 43, question: "A pentagon has how many sides?", options: ["4", "5", "6"], correct: 1, explanation: "Penta = 5." },
  { id: 44, question: "If 3x = 27, x = ?", options: ["7", "8", "9"], correct: 2, explanation: "27 ÷ 3 = 9." },
  { id: 45, question: "How many edges does a cube have?", options: ["8", "10", "12"], correct: 2, explanation: "12 edges." },
  { id: 46, question: "1 000 − 456 = ?", options: ["544", "554", "644"], correct: 0, explanation: "1000 − 456 = 544." },
  { id: 47, question: "Rectangle area 48 cm², width 6 cm. Length?", options: ["6 cm", "8 cm", "12 cm"], correct: 1, explanation: "48 ÷ 6 = 8 cm." },
  { id: 48, question: "How many seconds in 5 minutes?", options: ["30", "300", "500"], correct: 1, explanation: "5 × 60 = 300." },
  { id: 49, question: "7/10 − 2/5 = ?", options: ["3/10", "5/5", "1/2"], correct: 0, explanation: "2/5 = 4/10. 7/10 − 4/10 = 3/10." },
  { id: 50, question: "Bus leaves 8:45 a.m., arrives 11:20 a.m. Journey time?", options: ["2 hr 25 min", "2 hr 35 min", "3 hr 35 min"], correct: 1, explanation: "8:45 to 11:20 = 2h 35m." },
];

const languageQuestions: Question[] = [
  { id: 101, question: "Pauline placed the five _______ on the table.", options: ["tomatos", "tomatoes", "tomato's"], correct: 1, explanation: "Plural: tomatoes (add -es)." },
  { id: 102, question: "We may not _______ all our plans for today!", options: ["achieve", "acheive", "acheve"], correct: 0, explanation: "i before e: achieve." },
  { id: 103, question: "I _______ believe you can do better.", options: ["truly", "truely", "truley"], correct: 0, explanation: "Drop e from true: truly." },
  { id: 104, question: "The accident _______ at exactly 9:15 p.m.", options: ["occured", "ocurred", "occurred"], correct: 2, explanation: "Double r: occurred." },
  { id: 105, question: "You cannot move this rock; it is _______.", options: ["inmovable", "immovable", "imoveable"], correct: 1, explanation: "Prefix im- doubles m: immovable." },
  { id: 106, question: "Everyone read the story easily because it was _______.", options: ["legible", "illegible", "eligible"], correct: 0, explanation: "Legible = clear enough to read." },
  { id: 107, question: "Joey refused to put the _______ on his pet dog.", options: ["leash", "saddle", "hurdle"], correct: 0, explanation: "A leash controls a pet dog." },
  { id: 108, question: "Anna played guitar, tennis, and drew beautifully. She was _______.", options: ["bold", "jovial", "talented"], correct: 2, explanation: "Talented = having natural ability." },
  { id: 109, question: "Which word is CLOSEST in meaning to 'knack'?", options: ["joy", "love", "skill"], correct: 2, explanation: "A knack = natural skill." },
  { id: 110, question: "Which word is OPPOSITE to 'concealed'?", options: ["hid", "showed", "denied"], correct: 1, explanation: "Concealed = hidden. Opposite = showed." },
  { id: 111, question: "Which has correct capitalization?", options: ["The Trinidad Guardian newspaper", "the trinidad guardian newspaper", "The Trinidad guardian newspaper"], correct: 0, explanation: "Newspaper titles are proper nouns." },
  { id: 112, question: "Correctly punctuated list:", options: ["pencils: crayons drawing books and bags", "pencils crayons, drawing books and bags", "pencils, crayons, drawing books and bags"], correct: 2, explanation: "Commas separate list items." },
  { id: 113, question: "Correct dialogue:", options: ['"Why are you so active?" Shouted Shai\'s mother!', '"Why are you so active?" shouted Shai\'s mother.', '"Why are you so active? shouted Shai\'s mother"'], correct: 1, explanation: "Tag continues lowercase after ? in quotes." },
  { id: 114, question: "Correct punctuation:", options: ['"Who has the teacher\'s bag?" asked Mr Joseph.', '"Who has the teachers bag, asked Mr Joseph?"', '"Who has the teachers\'s bag?" asked Mr Joseph.'], correct: 0, explanation: "Teacher's (singular possessive)." },
  { id: 115, question: "Correct interrupted dialogue:", options: ['"I will come with you, said Tony, but I must eat first."', '"I will come with you," said Tony, "but I must eat first."', '"I will come with you" said Tony, but I must eat first."'], correct: 1, explanation: "Commas inside quotes when interrupted." },
  { id: 116, question: "All the children in my class _______ well.", options: ["read", "reads", "reading"], correct: 0, explanation: "Children = plural → read." },
  { id: 117, question: "The pineapple was shared between Lianna and _______.", options: ["I", "he", "me"], correct: 2, explanation: "After preposition → object pronoun me." },
  { id: 118, question: "The damage was _______ than last year's.", options: ["bad", "worse", "worst"], correct: 1, explanation: "Worse = comparative of bad." },
  { id: 119, question: "He walked home because he _______ his bus fare.", options: ["lost", "lose", "loss"], correct: 0, explanation: "Past tense: lost." },
  { id: 120, question: "Students stand _______ the teachers enter.", options: ["whenever", "since", "for"], correct: 0, explanation: "Whenever = every time that." },
  { id: 121, question: "Joanna, along with Khadine, _______ to participate.", options: ["were asking", "was asked", "were asked"], correct: 1, explanation: "Subject Joanna (singular) → was asked." },
  { id: 122, question: "Neither the boys nor their sister _______ tennis.", options: ["play", "plays", "playing"], correct: 1, explanation: "Verb agrees with nearest: sister → plays." },
  { id: 123, question: "The driver lost control _______ he was speeding.", options: ["but", "because", "although"], correct: 1, explanation: "Because = cause/reason." },
  { id: 124, question: "Choose the correct sentence:", options: ["Me and my brother went.", "My brother and I went.", "I and my brother went."], correct: 1, explanation: "My brother and I (subject form, others first)." },
  { id: 125, question: "Which word is an adverb?", options: ["quick", "quickly", "quicken"], correct: 1, explanation: "Adverbs often end in -ly." },
  { id: 126, question: "The children played _______ in the yard.", options: ["happy", "happily", "happiness"], correct: 1, explanation: "Need adverb: happily." },
  { id: 127, question: "Correct plural:", options: ["The childs are playing.", "The children are playing.", "The childrens are playing."], correct: 1, explanation: "Children = irregular plural." },
  { id: 128, question: "She _______ to school every day.", options: ["walk", "walks", "walking"], correct: 1, explanation: "3rd person singular → walks." },
  { id: 129, question: "Prefix 'un-' in 'unhappy' means", options: ["very", "not", "again"], correct: 1, explanation: "Un- = not." },
  { id: 130, question: "Synonym for 'beautiful'?", options: ["ugly", "gorgeous", "plain"], correct: 1, explanation: "Gorgeous = very beautiful." },
  { id: 131, question: "Antonym for 'brave'?", options: ["courageous", "bold", "cowardly"], correct: 2, explanation: "Cowardly = lacking courage." },
  { id: 132, question: "'The sun smiled down on us' is", options: ["simile", "metaphor", "personification"], correct: 2, explanation: "Human quality to non-human = personification." },
  { id: 133, question: "'She is as tall as a giraffe' is a", options: ["simile", "metaphor", "alliteration"], correct: 0, explanation: "Uses 'as' = simile." },
  { id: 134, question: "Past tense:", options: ["I am running fast.", "I ran to the store.", "I will run tomorrow."], correct: 1, explanation: "Ran = past tense." },
  { id: 135, question: "I _______ a student.", options: ["is", "are", "am"], correct: 2, explanation: "1st person singular: am." },
  { id: 136, question: "Suffix '-less' means", options: ["full of", "without", "able to"], correct: 1, explanation: "-less = without (hopeless)." },
  { id: 137, question: "Past tense of 'swim'?", options: ["swimed", "swam", "swum"], correct: 1, explanation: "Simple past: swam." },
  { id: 138, question: "Which is interrogative?", options: ["The cat sat.", "Did you finish?", "What a day!"], correct: 1, explanation: "Interrogative = question." },
  { id: 139, question: "She gave the book to _______.", options: ["he", "him", "his"], correct: 1, explanation: "After preposition → him." },
  { id: 140, question: "Correct spelling:", options: ["recieve", "receive", "receeve"], correct: 1, explanation: "i before e except after c: receive." },
  { id: 141, question: "'Quickly' is what part of speech?", options: ["adjective", "adverb", "noun"], correct: 1, explanation: "Describes how = adverb." },
  { id: 142, question: "Correct 'their':", options: ["Their going to the beach.", "They left their bags.", "Their is a cat."], correct: 1, explanation: "Their = possessive." },
  { id: 143, question: "Comparative of 'good'?", options: ["gooder", "better", "best"], correct: 1, explanation: "Better = irregular comparative." },
  { id: 144, question: "Which is a pronoun?", options: ["beautiful", "she", "running"], correct: 1, explanation: "She replaces a noun." },
  { id: 145, question: "Plural of 'child'?", options: ["childs", "childrens", "children"], correct: 2, explanation: "Children = irregular plural." },
  { id: 146, question: "The weather is _______ today.", options: ["nice", "nicely", "niceness"], correct: 0, explanation: "Adjective describes weather." },
  { id: 147, question: "Exclamatory sentences end with", options: ["Period (.)", "Question mark (?)", "Exclamation mark (!)"], correct: 2, explanation: "Exclamatory → !" },
  { id: 148, question: "Main idea is also called", options: ["detail", "topic sentence", "conclusion"], correct: 1, explanation: "Topic sentence = main idea." },
  { id: 149, question: "Correct spelling:", options: ["necesary", "necessary", "neccessary"], correct: 1, explanation: "One c, two s: necessary." },
  { id: 150, question: "Superlative of 'big'?", options: ["bigger", "biggest", "more big"], correct: 1, explanation: "Biggest = superlative." },
];

const scienceQuestions: Question[] = [
  { id: 201, question: "Which is NOT a sense organ?", options: ["Eye", "Heart", "Ear"], correct: 1, explanation: "Heart pumps blood, not a sense organ." },
  { id: 202, question: "Plants make food through", options: ["Respiration", "Photosynthesis", "Digestion"], correct: 1, explanation: "Photosynthesis uses sunlight, water, CO₂." },
  { id: 203, question: "Which gas do plants absorb?", options: ["Oxygen", "Nitrogen", "Carbon dioxide"], correct: 2, explanation: "Plants absorb CO₂, release O₂." },
  { id: 204, question: "Liquid to gas is called", options: ["condensation", "evaporation", "freezing"], correct: 1, explanation: "Evaporation = liquid → vapour." },
  { id: 205, question: "Renewable energy source?", options: ["Coal", "Solar energy", "Natural gas"], correct: 1, explanation: "Solar won't run out." },
  { id: 206, question: "Force pulling objects toward Earth?", options: ["friction", "gravity", "magnetism"], correct: 1, explanation: "Gravity attracts toward Earth's centre." },
  { id: 207, question: "Which is a mammal?", options: ["Crocodile", "Dolphin", "Turtle"], correct: 1, explanation: "Dolphins breathe air, warm-blooded, feed young milk." },
  { id: 208, question: "The skeleton provides", options: ["digestion", "support and protection", "respiration"], correct: 1, explanation: "Skeleton supports body, protects organs." },
  { id: 209, question: "Which absorbs water from soil?", options: ["Leaves", "Stem", "Roots"], correct: 2, explanation: "Roots absorb water and minerals." },
  { id: 210, question: "Sound travels fastest through", options: ["air", "water", "solids"], correct: 2, explanation: "Particles closest in solids." },
  { id: 211, question: "Conductor of electricity?", options: ["Rubber", "Copper", "Plastic"], correct: 1, explanation: "Copper is a metal conductor." },
  { id: 212, question: "Liquid to solid is", options: ["melting", "freezing", "boiling"], correct: 1, explanation: "Freezing = liquid → solid." },
  { id: 213, question: "Closest planet to Sun?", options: ["Venus", "Mercury", "Mars"], correct: 1, explanation: "Mercury is closest." },
  { id: 214, question: "Organ that pumps blood?", options: ["lungs", "liver", "heart"], correct: 2, explanation: "Heart pumps blood." },
  { id: 215, question: "Which is magnetic?", options: ["Wood", "Iron", "Glass"], correct: 1, explanation: "Iron attracts to magnets." },
  { id: 216, question: "Separate sand and water?", options: ["magnetism", "filtration", "evaporation only"], correct: 1, explanation: "Filtration separates solid from liquid." },
  { id: 217, question: "Largest organ?", options: ["liver", "brain", "skin"], correct: 2, explanation: "Skin is the largest organ." },
  { id: 218, question: "Gas needed for burning?", options: ["Carbon dioxide", "Nitrogen", "Oxygen"], correct: 2, explanation: "Oxygen required for combustion." },
  { id: 219, question: "Rain, snow, sleet, hail are", options: ["condensation", "precipitation", "evaporation"], correct: 1, explanation: "Precipitation = water falling from clouds." },
  { id: 220, question: "Earth orbits Sun in about", options: ["24 hours", "30 days", "365 days"], correct: 2, explanation: "One orbit = 365 days." },
  { id: 221, question: "Carnivore?", options: ["Cow", "Lion", "Rabbit"], correct: 1, explanation: "Lions eat only meat." },
  { id: 222, question: "Part producing pollen?", options: ["petal", "stamen", "pistil"], correct: 1, explanation: "Stamen = male part." },
  { id: 223, question: "Energy stored in food?", options: ["Kinetic", "Chemical", "Sound"], correct: 1, explanation: "Food = chemical energy." },
  { id: 224, question: "What causes day and night?", options: ["Moon orbiting", "Earth rotating", "Earth orbiting Sun"], correct: 1, explanation: "Earth's rotation = day/night." },
  { id: 225, question: "Chemical change?", options: ["Melting ice", "Burning wood", "Breaking glass"], correct: 1, explanation: "Burning creates new substances." },
  { id: 226, question: "Frogs are", options: ["Reptiles", "Amphibians", "Mammals"], correct: 1, explanation: "Frogs = amphibians." },
  { id: 227, question: "Vitamin from sunlight?", options: ["Vitamin A", "Vitamin C", "Vitamin D"], correct: 2, explanation: "Skin produces Vitamin D." },
  { id: 228, question: "Produces own light?", options: ["Moon", "Mirror", "Sun"], correct: 2, explanation: "Sun produces light. Moon reflects." },
  { id: 229, question: "Building blocks of life?", options: ["atoms", "cells", "molecules"], correct: 1, explanation: "Cells = basic unit of life." },
  { id: 230, question: "Earth layer we live on?", options: ["Core", "Mantle", "Crust"], correct: 2, explanation: "Crust = outermost layer." },
  { id: 231, question: "Red blood cells do what?", options: ["Fight infection", "Carry oxygen", "Help clot"], correct: 1, explanation: "Carry oxygen from lungs." },
  { id: 232, question: "Physical change?", options: ["Rusting iron", "Baking cake", "Melting chocolate"], correct: 2, explanation: "Melting chocolate can reverse." },
  { id: 233, question: "Measures temperature?", options: ["barometer", "thermometer", "rain gauge"], correct: 1, explanation: "Thermometer measures temp." },
  { id: 234, question: "Which lays eggs?", options: ["Dog", "Chicken", "Cat"], correct: 1, explanation: "All birds lay eggs." },
  { id: 235, question: "Green substance in leaves?", options: ["cytoplasm", "chlorophyll", "cellulose"], correct: 1, explanation: "Chlorophyll captures sunlight." },
  { id: 236, question: "NOT precipitation?", options: ["Fog", "Rain", "Hail"], correct: 0, explanation: "Fog = cloud at ground level." },
  { id: 237, question: "Wheel and rope is a", options: ["lever", "pulley", "inclined plane"], correct: 1, explanation: "Pulley uses wheel + rope." },
  { id: 238, question: "Moon is Earth's", options: ["star", "planet", "satellite"], correct: 2, explanation: "Natural satellite." },
  { id: 239, question: "Insulator?", options: ["Copper", "Aluminium", "Rubber"], correct: 2, explanation: "Rubber doesn't conduct." },
  { id: 240, question: "Pollination transfers from", options: ["stem to root", "stamen to pistil", "petal to leaf"], correct: 1, explanation: "Male (stamen) to female (pistil)." },
  { id: 241, question: "Water boils at ___ °C", options: ["90°C", "100°C", "110°C"], correct: 1, explanation: "100°C at sea level." },
  { id: 242, question: "Fossil fuel?", options: ["Wind", "Petroleum", "Solar"], correct: 1, explanation: "Petroleum from ancient organisms." },
  { id: 243, question: "Caused by virus?", options: ["Malaria", "Influenza", "Ringworm"], correct: 1, explanation: "Flu is viral." },
  { id: 244, question: "Breaks down food?", options: ["circulatory", "digestive", "nervous"], correct: 1, explanation: "Digestive system." },
  { id: 245, question: "Transparent?", options: ["Wood", "Glass", "Metal"], correct: 1, explanation: "Glass lets light through." },
  { id: 246, question: "Force opposing motion?", options: ["gravity", "friction", "magnetism"], correct: 1, explanation: "Friction resists motion." },
  { id: 247, question: "Decomposer?", options: ["Grass", "Mushroom", "Rabbit"], correct: 1, explanation: "Fungi break down dead matter." },
  { id: 248, question: "Water vapour → liquid =", options: ["evaporation", "condensation", "sublimation"], correct: 1, explanation: "Condensation = gas → liquid." },
  { id: 249, question: "Bones in adult body?", options: ["106", "206", "306"], correct: 1, explanation: "206 bones." },
  { id: 250, question: "Energy of moving car?", options: ["Potential", "Kinetic", "Chemical"], correct: 1, explanation: "Kinetic = motion energy." },
];

const socialQuestions: Question[] = [
  { id: 301, question: "Caribbean is in which ocean?", options: ["Pacific", "Atlantic", "Indian"], correct: 1, explanation: "Caribbean Sea is in the Atlantic." },
  { id: 302, question: "First inhabitants?", options: ["Arawaks and Caribs", "Mayans", "Aztecs"], correct: 0, explanation: "Arawaks (Tainos) and Caribs (Kalinagos)." },
  { id: 303, question: "Who arrived in 1492?", options: ["Christopher Columbus", "Vasco da Gama", "Sir Francis Drake"], correct: 0, explanation: "Columbus arrived 1492." },
  { id: 304, question: "Capital of Barbados?", options: ["Kingston", "Bridgetown", "Castries"], correct: 1, explanation: "Bridgetown = Barbados capital." },
  { id: 305, question: "Grenada is known as", options: ["The Spice Isle", "Land of the Hanging Rocks", "Rainforest Isle"], correct: 0, explanation: "The Spice Isle (nutmeg)." },
  { id: 306, question: "Carnival includes", options: ["Costumes and parading", "Building snowmen", "Ice skating"], correct: 0, explanation: "Costumes, music, street parades." },
  { id: 307, question: "Enslaved Africans worked on", options: ["factories", "plantations", "mines"], correct: 1, explanation: "Sugar and other plantations." },
  { id: 308, question: "Crop introduced by Europeans?", options: ["Cassava", "Sugarcane", "Sweet potato"], correct: 1, explanation: "Sugarcane brought by colonizers." },
  { id: 309, question: "Largest Caribbean country?", options: ["Jamaica", "Cuba", "Trinidad"], correct: 1, explanation: "Cuba is largest." },
  { id: 310, question: "Citizens electing representatives =", options: ["Monarchy", "Democracy", "Dictatorship"], correct: 1, explanation: "Democracy." },
  { id: 311, question: "CARICOM's purpose?", options: ["Organizing sports", "Economic cooperation", "Managing tourism"], correct: 1, explanation: "Economic integration." },
  { id: 312, question: "Head of state in constitutional monarchy?", options: ["Prime Minister", "Monarch", "President"], correct: 1, explanation: "Monarch = ceremonial head." },
  { id: 313, question: "Citizen's right?", options: ["Avoiding taxes", "Voting", "Breaking laws"], correct: 1, explanation: "Voting = fundamental right." },
  { id: 314, question: "NOT bordering Caribbean?", options: ["Central America", "South America", "Africa"], correct: 2, explanation: "Africa is across the Atlantic." },
  { id: 315, question: "Barbados currency?", options: ["Jamaican dollar", "Barbados dollar", "EC dollar"], correct: 1, explanation: "Barbados dollar (BDS)." },
  { id: 316, question: "Emancipation Day celebrates", options: ["Independence", "End of slavery", "Discovery"], correct: 1, explanation: "End of slavery (1834/1838)." },
  { id: 317, question: "Steelpan originated in", options: ["Jamaica", "Trinidad and Tobago", "Barbados"], correct: 1, explanation: "Trinidad and Tobago." },
  { id: 318, question: "Common Caribbean disaster?", options: ["Tornadoes", "Hurricanes", "Blizzards"], correct: 1, explanation: "Hurricanes June-November." },
  { id: 319, question: "Physical features map?", options: ["Political map", "Physical map", "Road map"], correct: 1, explanation: "Physical maps show mountains, rivers." },
  { id: 320, question: "Prime Minister heads", options: ["the judiciary", "the government", "the military"], correct: 1, explanation: "PM = head of government." },
  { id: 321, question: "Civic responsibility?", options: ["Watching TV", "Obeying the law", "Playing games"], correct: 1, explanation: "Obeying law = civic duty." },
  { id: 322, question: "Caribbean islands form an", options: ["archipelago", "continent", "isthmus"], correct: 0, explanation: "Archipelago = chain of islands." },
  { id: 323, question: "Major Caribbean export?", options: ["Wheat", "Sugarcane products", "Cars"], correct: 1, explanation: "Sugar and rum." },
  { id: 324, question: "Crop Over in", options: ["Jamaica", "Barbados", "St. Lucia"], correct: 1, explanation: "Crop Over = Barbados." },
  { id: 325, question: "Three branches of government:", options: ["Executive, Legislative, Judicial", "Army, Navy, Air Force", "Federal, State, Local"], correct: 0, explanation: "Executive, Legislative, Judicial." },
  { id: 326, question: "Volcanic island?", options: ["Barbados", "St. Vincent", "Antigua"], correct: 1, explanation: "St. Vincent is volcanic." },
  { id: 327, question: "Reggae from", options: ["Trinidad", "Jamaica", "Cuba"], correct: 1, explanation: "Jamaica, late 1960s." },
  { id: 328, question: "Judiciary's role?", options: ["Make laws", "Enforce laws", "Interpret laws"], correct: 2, explanation: "Judiciary interprets laws." },
  { id: 329, question: "Good citizen:", options: ["Ignoring problems", "Community service", "Avoiding voting"], correct: 1, explanation: "Good citizens help community." },
  { id: 330, question: "Equator is", options: ["line of latitude", "line of longitude", "mountain"], correct: 0, explanation: "0° latitude." },
  { id: 331, question: "Renewable resource?", options: ["Bauxite", "Fish", "Oil"], correct: 1, explanation: "Fish are renewable if managed." },
  { id: 332, question: "Barbados Independence Day?", options: ["March 15", "August 1", "November 30"], correct: 2, explanation: "November 30, 1966." },
  { id: 333, question: "Important Caribbean industry?", options: ["Auto manufacturing", "Tourism", "Steel production"], correct: 1, explanation: "Tourism is major industry." },
  { id: 334, question: "A constitution is", options: ["a type of food", "supreme law", "an instrument"], correct: 1, explanation: "Supreme law of a country." },
  { id: 335, question: "NOT in Greater Antilles?", options: ["Cuba", "Barbados", "Jamaica"], correct: 1, explanation: "Barbados = Lesser Antilles." },
  { id: 336, question: "Citizen's duty?", options: ["Travel freely", "Pay taxes", "Own property"], correct: 1, explanation: "Paying taxes = duty." },
  { id: 337, question: "Culture influenced by", options: ["Only Africa", "Africa, Europe, Indigenous", "Only Europe"], correct: 1, explanation: "Blend of all three + Indian." },
  { id: 338, question: "Legislative branch does what?", options: ["Enforces laws", "Makes laws", "Interprets laws"], correct: 1, explanation: "Parliament makes laws." },
  { id: 339, question: "Biodiversity =", options: ["Variety of life", "Number of people", "Types of rocks"], correct: 0, explanation: "Variety of species." },
  { id: 340, question: "Deforestation causes", options: ["More animals", "Soil erosion", "More rainfall"], correct: 1, explanation: "Soil erosion, habitat loss." },
  { id: 341, question: "OECS stands for", options: ["Organization of Eastern Caribbean States", "Organization of Economic Societies", "Order of Eastern Schools"], correct: 0, explanation: "Organization of Eastern Caribbean States." },
  { id: 342, question: "Form of pollution?", options: ["Planting trees", "Air pollution from burning", "Recycling"], correct: 1, explanation: "Burning waste = air pollution." },
  { id: 343, question: "Prime Meridian passes through", options: ["Jamaica", "Greenwich, England", "Barbados"], correct: 1, explanation: "0° longitude = Greenwich." },
  { id: 344, question: "Service industry?", options: ["Farming", "Banking and education", "Mining"], correct: 1, explanation: "Banking/education = services." },
  { id: 345, question: "Caribbean climate?", options: ["arid and cold", "tropical and warm", "polar"], correct: 1, explanation: "Tropical, warm year-round." },
  { id: 346, question: "Government raises money by", options: ["Printing money", "Collecting taxes", "Borrowing only"], correct: 1, explanation: "Taxes = main revenue." },
  { id: 347, question: "Cultural heritage =", options: ["New buildings", "Traditions passed down", "Modern tech"], correct: 1, explanation: "Traditions, customs, history." },
  { id: 348, question: "St. Lucia's Pitons are", options: ["mountains", "UNESCO World Heritage", "rivers"], correct: 1, explanation: "UNESCO World Heritage Site." },
  { id: 349, question: "Caribbean named after", options: ["Arawak", "Carib (Kalinago)", "Taino"], correct: 1, explanation: "Named after Carib people." },
  { id: 350, question: "Push factor for migration?", options: ["Better jobs abroad", "Natural disasters", "Good schools"], correct: 1, explanation: "Push = negative conditions." },
];

function getQuestions(subject: Subject): Question[] {
  const pools: Record<Subject, Question[]> = { math: mathQuestions, language: languageQuestions, science: scienceQuestions, social: socialQuestions };
  const pool = [...pools[subject]];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, 30);
}

const subjectInfo: Record<Subject, { name: string; emoji: string; color: string; desc: string; bg: string }> = {
  math: { name: 'Mathematics', emoji: '🔢', color: 'from-blue-500 to-cyan-500', desc: 'Numbers, fractions, geometry & problem solving', bg: 'bg-blue-50' },
  language: { name: 'Language Arts', emoji: '📖', color: 'from-purple-500 to-pink-500', desc: 'Grammar, spelling, writing & comprehension', bg: 'bg-purple-50' },
  science: { name: 'Science', emoji: '🔬', color: 'from-green-500 to-emerald-500', desc: 'Living things, energy, earth & the human body', bg: 'bg-green-50' },
  social: { name: 'Social Studies', emoji: '🌍', color: 'from-orange-500 to-amber-500', desc: 'Caribbean history, culture & government', bg: 'bg-orange-50' },
};

const TOTAL_TIME = 60 * 60;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// THEME INJECTOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ThemeStyles = () => (
  <style>{`
    [data-theme="dark"] .bg-white { background-color: #1f2937 !important; }
    [data-theme="dark"] .bg-gray-50, [data-theme="dark"] .bg-indigo-50, [data-theme="dark"] .bg-purple-50, [data-theme="dark"] .bg-green-50, [data-theme="dark"] .bg-orange-50 { background-color: #111827 !important; }
    [data-theme="dark"] .text-gray-800 { color: #f9fafb !important; }
    [data-theme="dark"] .text-gray-700 { color: #f3f4f6 !important; }
    [data-theme="dark"] .text-gray-600, [data-theme="dark"] .text-gray-500 { color: #9ca3af !important; }
    [data-theme="dark"] .border-gray-100 { border-color: #374151 !important; }
    [data-theme="dark"] .border-gray-200 { border-color: #4b5563 !important; }

    [data-theme="electric-yellow"] .bg-white { background-color: #fefce8 !important; }
    [data-theme="electric-yellow"] .bg-gray-50, [data-theme="electric-yellow"] .bg-indigo-50, [data-theme="electric-yellow"] .bg-purple-50, [data-theme="electric-yellow"] .bg-green-50, [data-theme="electric-yellow"] .bg-orange-50 { background-color: #fef08a !important; }
    [data-theme="electric-yellow"] .bg-gradient-to-r, [data-theme="electric-yellow"] .bg-gradient-to-br { background-image: linear-gradient(to right, #eab308, #ca8a04) !important; color: white !important; }
    [data-theme="electric-yellow"] .text-gray-800 { color: #713f12 !important; }

    [data-theme="midnight-purple"] .bg-white { background-color: #3b0764 !important; }
    [data-theme="midnight-purple"] .bg-gray-50, [data-theme="midnight-purple"] .bg-indigo-50, [data-theme="midnight-purple"] .bg-purple-50, [data-theme="midnight-purple"] .bg-green-50, [data-theme="midnight-purple"] .bg-orange-50 { background-color: #2e1065 !important; }
    [data-theme="midnight-purple"] .bg-gradient-to-r, [data-theme="midnight-purple"] .bg-gradient-to-br { background-image: linear-gradient(to right, #7e22ce, #4c1d95) !important; color: white !important; }
    [data-theme="midnight-purple"] .text-gray-800 { color: #e9d5ff !important; }
    [data-theme="midnight-purple"] .text-gray-700 { color: #d8b4fe !important; }
    [data-theme="midnight-purple"] .text-gray-600, [data-theme="midnight-purple"] .text-gray-500 { color: #c084fc !important; }
    [data-theme="midnight-purple"] .border-gray-100 { border-color: #581c87 !important; }

    [data-theme="oreng-orange"] .bg-white { background-color: #fff7ed !important; }
    [data-theme="oreng-orange"] .bg-gray-50, [data-theme="oreng-orange"] .bg-indigo-50, [data-theme="oreng-orange"] .bg-purple-50, [data-theme="oreng-orange"] .bg-green-50, [data-theme="oreng-orange"] .bg-orange-50 { background-color: #ffedd5 !important; }
    [data-theme="oreng-orange"] .bg-gradient-to-r, [data-theme="oreng-orange"] .bg-gradient-to-br { background-image: linear-gradient(to right, #ea580c, #c2410c) !important; color: white !important; }
    [data-theme="oreng-orange"] .text-gray-800 { color: #7c2d12 !important; }
    [data-theme="oreng-orange"] .border-gray-100 { border-color: #ffedd5 !important; }
  `}</style>
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// APP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [page, setPage] = useState<Page>(() => loadUser() ? 'home' : 'auth');
  const [user, setUser] = useState<User | null>(loadUser);
  const [subject, setSubject] = useState<Subject | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [results, setResults] = useState<QuizResult[]>(loadResults);
  const [qIdx, setQIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [flagged, setFlagged] = useState<Set<number>>(new Set());
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [quizReady, setQuizReady] = useState(false);
  const [noteSubject, setNoteSubject] = useState<Subject | null>(null);
  const [noteTopic, setNoteTopic] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<QuizResult | null>(null);
  const [blynk, setBlynk] = useState<BlynkStyle>(loadBlynk);
  const [mpRoom, setMpRoom] = useState<MPRoom | null>(null);
  const [mpSession, setMpSession] = useState<MPSession | null>(null);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('cpea_theme') || 'default');

  useEffect(() => {
    localStorage.setItem('cpea_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keep the searchable account directory updated whenever profile data changes.
  useEffect(() => {
    if (user) syncAccountProfile(user, blynk, results);
  }, [user?.id, user?.name, user?.coins, blynk, results.length]);

  useEffect(() => {
    if (!quizReady || page !== 'quiz') return;
    if (timeLeft <= 0) { doSubmit(); return; }
    const t = setInterval(() => setTimeLeft(v => v - 1), 1000);
    return () => clearInterval(t);
  }, [quizReady, page, timeLeft]);

  const doLogin = async (u: User) => {
    setUser(u); saveUser(u);
    let activeBlynk = blynk;
    // Load blynk + coins from Supabase if available
    if (supabase && !u.id.startsWith('guest-')) {
      const { data } = await supabase.from('profiles').select('blynk, coins').eq('id', u.id).single();
      if (data) {
        if (data.blynk) { activeBlynk = data.blynk as BlynkStyle; setBlynk(activeBlynk); saveBlynk(activeBlynk); }
        if (data.coins !== undefined) {
          const withCoins = { ...u, coins: data.coins };
          setUser(withCoins); saveUser(withCoins); syncAccountProfile(withCoins, activeBlynk, results);
        } else syncAccountProfile(u, activeBlynk, results);
      } else syncAccountProfile(u, activeBlynk, results);
    } else {
      syncAccountProfile(u, activeBlynk, results);
    }
    setPage('home');
  };
  const doLogout = () => { setUser(null); saveUser(null); setPage('auth'); };

  const startQuiz = (s: Subject) => {
    setSubject(s); setQuestions(getQuestions(s)); setQIdx(0); setAnswers({});
    setFlagged(new Set()); setTimeLeft(TOTAL_TIME); setQuizReady(false); setPage('quiz');
  };

  const doSubmit = () => {
    if (!subject) return;
    let score = 0;
    questions.forEach((q, i) => { if (answers[i] === q.correct) score++; });
    const pct = Math.round((score / questions.length) * 100);
    const tu = TOTAL_TIME - timeLeft;
    const r: QuizResult = { id: Date.now().toString(), subject, score, total: questions.length, percentage: pct, timeUsed: tu, date: new Date().toLocaleDateString() };
    const updated = [...results, r];
    setResults(updated); saveResults(updated); setLastResult(r); setPage('results');
    // Earn coins: 5 for participation + 1 per correct answer
    earnCoins(5 + score, updated);
  };

  const openLearn = (s: Subject) => { setNoteSubject(s); setNoteTopic(null); setPage('learn-topic'); };

  const updateBlynk = async (b: BlynkStyle) => {
    setBlynk(b); saveBlynk(b);
    if (user) syncAccountProfile(user, b, results);
    if (supabase && user && !user.id.startsWith('guest-')) {
      await supabase.from('profiles').update({ blynk: b }).eq('id', user.id);
    }
  };

  const earnCoins = async (amount: number, latestResults = results) => {
    if (!user) return;
    const next = { ...user, coins: user.coins + amount };
    setUser(next); saveUser(next); syncAccountProfile(next, blynk, latestResults);
    if (supabase && !user.id.startsWith('guest-')) {
      await supabase.from('profiles').update({ coins: next.coins }).eq('id', user.id);
    }
  };

  // ROUTING
  const withTheme = (comp: React.ReactNode) => <><ThemeStyles />{comp}</>;
  
  if (page === 'auth') return withTheme(<AuthPage onLogin={doLogin} />);
  if (page === 'home') return withTheme(<HomePage user={user!} onLogout={doLogout} results={results} blynk={blynk}
    theme={theme} setTheme={setTheme}
    onStartQuiz={(s) => startQuiz(s)} onLearn={(s) => openLearn(s)}
    onGoPractice={() => setPage('practice-subjects')} onGoLearn={() => setPage('learn-subjects')}
    onGoProgress={() => setPage('progress')} onGoBlynk={() => setPage('blynk-customize')}
    onGoAccount={() => setPage('account')} onGoSearchAccounts={() => setPage('search-accounts')}
    onGoMultiQuiz={() => setPage('multi-quiz-hub')} />);
  if (page === 'blynk-customize') return withTheme(<BlynkCustomizePage blynk={blynk} onSave={updateBlynk} onBack={() => setPage('home')} />);
  if (page === 'practice-subjects') return withTheme(<PracticeSubjectsPage onStart={startQuiz} onBack={() => setPage('home')} />);
  if (page === 'learn-subjects') return withTheme(<LearnSubjectsPage onLearn={openLearn} onBack={() => setPage('home')} />);
  if (page === 'quiz' && subject && questions.length > 0) return withTheme(!quizReady
    ? <QuizStartPage subject={subject} onStart={() => setQuizReady(true)} onBack={() => setPage('home')} />
    : <QuizView questions={questions} qIdx={qIdx} setQIdx={setQIdx} answers={answers} setAnswers={setAnswers}
        flagged={flagged} setFlagged={setFlagged} timeLeft={timeLeft} subject={subject}
        onSubmit={doSubmit} onBack={() => setPage('home')} />);
  if (page === 'results' && lastResult) return withTheme(<ResultsView result={lastResult} onRetake={() => startQuiz(lastResult.subject)} onChangeSubject={() => setPage('practice-subjects')} />);
  if (page === 'learn-topic' && noteSubject) return withTheme(<LearnTopicPage subject={noteSubject} topic={noteTopic}
    onBack={() => setPage('learn-subjects')} onTopicSelect={setNoteTopic} />);
  if (page === 'progress') return withTheme(<ProgressPage results={results} onBack={() => setPage('home')} />);
  if (page === 'account') return withTheme(<AccountPage user={user!} blynk={blynk} results={results} onBack={() => setPage('home')} />);
  if (page === 'search-accounts') return withTheme(<SearchAccountsPage onBack={() => setPage('home')} />);
  if (page === 'multi-quiz-hub') return withTheme(<MultiQuizHub user={user!} blynk={blynk} onBack={() => setPage('home')}
    onJoinLobby={(session, room) => { setMpSession(session); setMpRoom(room); setPage('multi-quiz-lobby'); }} />);
  if (page === 'multi-quiz-lobby' && mpSession) return withTheme(<MultiQuizLobby
    session={mpSession}
    initialRoom={mpRoom}
    user={user!}
    blynk={blynk}
    onRoomUpdate={setMpRoom}
    onBack={() => { setMpRoom(null); setMpSession(null); setPage('multi-quiz-hub'); }}
    onStartGame={() => setPage('multi-quiz-game')} />);
  if (page === 'multi-quiz-game' && mpSession && mpRoom) return withTheme(<MultiQuizGame
    session={mpSession}
    initialRoom={mpRoom}
    user={user!}
    onRoomUpdate={setMpRoom}
    onBack={() => { setMpRoom(null); setMpSession(null); setPage('home'); }} />);
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH PAGE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function AuthPage({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<'options' | 'email'>('email');
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [checkEmail, setCheckEmail] = useState(false);
  // email/password only; Supabase if configured, otherwise local demo accounts

  // Handle Supabase OAuth session on redirect back
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) return;
      setLoading(true);
      await ensureProfile(session.user.id, session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'User', session.user.email || '');
      const profile = await loadProfile(session.user.id);
      onLogin({ id: session.user.id, name: profile?.name || 'User', email: session.user.email || '', provider: 'oauth', joined: new Date().toLocaleDateString(), coins: profile?.coins ?? 50 });
    });
  }, []);

  const ensureProfile = async (id: string, name: string, email: string) => {
    if (!supabase) return;
    const { data } = await supabase.from('profiles').select('id').eq('id', id).single();
    if (!data) {
      await supabase.from('profiles').insert({ id, name, email, coins: 50, blynk: DEFAULT_BLYNK, tests_taken: 0, best_score: 0, avg_score: 0 });
    }
  };

  const loadProfile = async (id: string) => {
    if (!supabase) return null;
    const { data } = await supabase.from('profiles').select('*').eq('id', id).single();
    return data;
  };

  const guestLogin = () => {
    onLogin({ id: 'guest-' + Date.now(), name: 'Guest', email: '', provider: 'guest', joined: new Date().toLocaleDateString(), coins: 0 });
  };

  const emailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');

    // Supabase email auth if configured
    if (supabase) {
      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
        if (error) { setError(error.message); setLoading(false); return; }
        if (data.user && !data.session) { setCheckEmail(true); setLoading(false); return; }
        if (data.user && data.session) {
          await ensureProfile(data.user.id, name || email.split('@')[0], email);
          onLogin({ id: data.user.id, name: name || email.split('@')[0], email, provider: 'email', joined: new Date().toLocaleDateString(), coins: 50 });
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) { setError(error.message); setLoading(false); return; }
        if (data.user) {
          const profile = await loadProfile(data.user.id);
          onLogin({ id: data.user.id, name: profile?.name || email.split('@')[0], email, provider: 'email', joined: new Date().toLocaleDateString(), coins: profile?.coins ?? 50 });
        }
      }
      setLoading(false);
      return;
    }

    // Local fallback accounts for classroom/simple use
    const localUsers: Array<{ id: string; name: string; email: string; password: string; joined: string; coins: number }> = JSON.parse(localStorage.getItem('cpea_local_users') || '[]');
    const existing = localUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (isSignUp) {
      if (existing) { setError('An account with that email already exists. Try logging in.'); setLoading(false); return; }
      const newUser = { id: 'local-' + email.toLowerCase().replace(/[^a-z0-9]/g, '-'), name: name || email.split('@')[0], email, password, joined: new Date().toLocaleDateString(), coins: 50 };
      localUsers.push(newUser);
      localStorage.setItem('cpea_local_users', JSON.stringify(localUsers));
      onLogin({ ...newUser, provider: 'local-email' });
    } else {
      if (!existing || existing.password !== password) { setError('Wrong email or password.'); setLoading(false); return; }
      onLogin({ id: existing.id, name: existing.name, email: existing.email, provider: 'local-email', joined: existing.joined, coins: existing.coins ?? 50 });
    }
    setLoading(false);
  };

  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center">
      <div className="text-center text-white"><div className="text-6xl mb-4 animate-bounce">🎓</div><p className="text-xl font-bold">Signing you in...</p><div className="mt-4 w-8 h-8 border-4 border-white/30 border-t-white rounded-full animate-spin mx-auto"></div></div>
    </div>
  );

  if (checkEmail) return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md w-full text-center">
        <div className="text-6xl mb-4">📧</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Check your email!</h2>
        <p className="text-gray-500 text-sm">We sent a confirmation link to <b>{email}</b>. Click it to activate your account, then come back and sign in.</p>
        <button onClick={() => { setCheckEmail(false); setIsSignUp(false); }} className="mt-6 bg-indigo-600 text-white font-bold rounded-xl px-6 py-3">Back to Sign In</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none"><div className="absolute top-10 left-10 w-72 h-72 bg-yellow-400/20 rounded-full blur-3xl animate-pulse"></div><div className="absolute bottom-10 right-10 w-96 h-96 bg-blue-400/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }}></div></div>
      <div className="relative bg-white/95 backdrop-blur-xl rounded-3xl shadow-2xl p-8 md:p-10 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="text-6xl mb-3">🎓</div>
          <h1 className="text-3xl md:text-4xl font-extrabold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">Let's Pass CPEA!</h1>
          <p className="text-gray-500 mt-2 text-sm">Caribbean Primary Exit Assessment • Practice & Learn</p>
        </div>

        <div className="bg-blue-50 border border-blue-200 text-blue-700 text-xs rounded-xl p-3 mb-4 text-center">
          Use Email + Password to make an account, or Guest if you just want to try it quickly.
        </div>

        {mode === 'options' ? (
          <div className="space-y-3">
            <button onClick={() => setMode('email')} className="w-full flex items-center gap-3 bg-indigo-50 hover:bg-indigo-100 border-2 border-indigo-200 text-indigo-700 rounded-xl px-5 py-3.5 transition-all">
              <span>✉️</span><span className="font-medium">Email & Password</span>
            </button>
            <button onClick={guestLogin} className="w-full bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 text-white font-semibold rounded-xl px-5 py-3.5 shadow-md">👤 Continue as Guest</button>
            <p className="text-center text-xs text-gray-400">Guest is local only. Email accounts are saved on this device, or Supabase if configured.</p>
            {error && <p className="text-red-500 text-sm text-center bg-red-50 rounded-lg p-2">{error}</p>}
          </div>
        ) : (
          <form onSubmit={emailAuth} className="space-y-4">
            <div className="flex gap-2 mb-2">
              <button type="button" onClick={() => setMode('options')} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">← Back</button>
              <div className="flex-1" />
              <button type="button" onClick={() => setIsSignUp(false)} className={`text-sm font-medium px-3 py-1 rounded-lg ${!isSignUp ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-700'}`}>Sign In</button>
              <button type="button" onClick={() => setIsSignUp(true)} className={`text-sm font-medium px-3 py-1 rounded-lg ${isSignUp ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-700'}`}>Sign Up</button>
            </div>
            {isSignUp && <div><label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:border-indigo-400 outline-none" /></div>}
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:border-indigo-400 outline-none" required /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Password</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 focus:border-indigo-400 outline-none" required /></div>
            {error && <p className="text-red-500 text-sm bg-red-50 rounded-lg p-2">{error}</p>}
            <button type="submit" className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-semibold rounded-xl px-5 py-3.5 shadow-lg">{isSignUp ? 'Create Account' : 'Sign In'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HOME PAGE — Big subjects at top, action buttons at bottom
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function HomePage({ user, onLogout, results, blynk, theme, setTheme, onStartQuiz, onLearn, onGoPractice, onGoLearn, onGoProgress, onGoBlynk, onGoAccount, onGoSearchAccounts, onGoMultiQuiz }: {
  user: User; onLogout: () => void; results: QuizResult[]; blynk: BlynkStyle;
  theme: string; setTheme: (t: string) => void;
  onStartQuiz: (s: Subject) => void; onLearn: (s: Subject) => void;
  onGoPractice: () => void; onGoLearn: () => void; onGoProgress: () => void;
  onGoBlynk: () => void; onGoAccount: () => void; onGoSearchAccounts: () => void; onGoMultiQuiz: () => void;
}) {
  const totalQuizzes = results.length;
  const avgScore = totalQuizzes > 0 ? Math.round(results.reduce((a, r) => a + r.percentage, 0) / totalQuizzes) : 0;
  const bestScore = totalQuizzes > 0 ? Math.max(...results.map(r => r.percentage)) : 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 via-white to-purple-50">
      {/* Hero */}
      <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500 text-white relative overflow-hidden">
        <div className="absolute inset-0 opacity-10"><div className="absolute top-5 left-5 text-8xl animate-bounce" style={{animationDuration:'3s'}}>📚</div><div className="absolute top-20 right-10 text-6xl animate-pulse">🎯</div><div className="absolute bottom-5 left-1/3 text-7xl animate-bounce" style={{animationDuration:'4s'}}>✏️</div></div>
        <div className="relative max-w-5xl mx-auto px-4 py-10 md:py-14">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <span className="text-4xl">🎓</span>
              <div><h1 className="text-2xl md:text-4xl font-extrabold">Let's Pass CPEA!</h1><p className="text-indigo-200 text-sm mt-1">hey {user.name} 👋 ready to crush it today?</p></div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-xs bg-yellow-400/30 border border-yellow-300/50 px-3 py-1.5 rounded-full flex items-center gap-1 font-bold">
                🪙 {user.coins}
              </div>
              <button onClick={onGoAccount} className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-full transition-all border border-white/30">👤 Account</button>
              <button onClick={onGoSearchAccounts} className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-full transition-all border border-white/30">🔎 Search</button>
              <button onClick={onGoBlynk} className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-full transition-all flex items-center gap-1 border border-white/30">
                <MiniBlynk blynk={blynk} size={18} /> Blynk Studio
              </button>
              <select value={theme} onChange={e => setTheme(e.target.value)} className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-full transition-all outline-none border border-white/30 appearance-none cursor-pointer">
                <option value="default" className="text-gray-800">Light Theme</option>
                <option value="dark" className="text-gray-800">Dark Theme</option>
                <option value="electric-yellow" className="text-gray-800">Electric Yellow</option>
                <option value="midnight-purple" className="text-gray-800">Midnight Purple</option>
                <option value="oreng-orange" className="text-gray-800">Oreng Orange</option>
              </select>
              <span className="text-xs bg-white/20 px-3 py-1.5 rounded-full hidden sm:inline">{user.email || 'Guest'}</span>
              <button onClick={onLogout} className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full transition-all">Logout</button>
            </div>
          </div>
          {totalQuizzes > 0 && <div className="grid grid-cols-3 gap-3 mt-6">
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4 text-center"><div className="text-2xl font-extrabold">{totalQuizzes}</div><div className="text-xs text-indigo-200">Tests Taken</div></div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4 text-center"><div className="text-2xl font-extrabold">{avgScore}%</div><div className="text-xs text-indigo-200">Average</div></div>
            <div className="bg-white/15 backdrop-blur-sm rounded-xl p-4 text-center"><div className="text-2xl font-extrabold">{bestScore}%</div><div className="text-xs text-indigo-200">Best</div></div>
          </div>}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* BIG subject cards */}
        <h2 className="text-2xl font-bold text-gray-800 mb-1">pick a subject 📚</h2>
        <p className="text-gray-500 text-sm mb-5">jump straight into a test or start learning — your choice!</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
          {(['math', 'language', 'science', 'social'] as Subject[]).map(s => (
            <div key={s} className={`${subjectInfo[s].bg} rounded-2xl p-6 shadow-lg border border-gray-100 hover:shadow-xl transition-all hover:-translate-y-1`}>
              <div className={`inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br ${subjectInfo[s].color} items-center justify-center text-3xl mb-4 shadow-md`}>{subjectInfo[s].emoji}</div>
              <h3 className="text-xl font-bold text-gray-800 mb-1">{subjectInfo[s].name}</h3>
              <p className="text-sm text-gray-500 mb-5">{subjectInfo[s].desc}</p>
              <div className="space-y-2">
                <button onClick={() => onLearn(s)} className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-white hover:bg-green-50 border-2 border-green-200 text-green-700 font-medium text-sm transition-all">
                  <span>📖 Learn</span><span>→</span>
                </button>
                <button onClick={() => onStartQuiz(s)} className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold text-sm transition-all shadow-md">
                  <span>🚀 Start Practice Test</span><span>→</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Encouragement */}
        <div className="bg-gradient-to-r from-yellow-50 to-orange-50 border-2 border-yellow-200 rounded-2xl p-6 mb-10">
          <div className="flex items-start gap-3"><span className="text-3xl">💪</span><div><h3 className="font-bold text-gray-800 mb-1">you got this, seriously!</h3><p className="text-sm text-gray-600 leading-relaxed">the CPEA is 60% external exam + 40% school-based assessment. practising papers and reviewing topics makes a huge difference. even 20 minutes a day adds up! 🎯</p></div></div>
        </div>

        {/* Bottom action buttons */}
        <h3 className="text-lg font-bold text-gray-800 mb-3">or pick a section below 😊</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <button onClick={onGoPractice} className="group bg-white rounded-2xl p-5 shadow-md hover:shadow-xl border-2 border-gray-100 hover:border-indigo-300 transition-all hover:-translate-y-1 text-left">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-xl mb-3 shadow-md group-hover:scale-110 transition-transform">📝</div>
            <h3 className="text-base font-bold text-gray-800 mb-1">Practice</h3>
            <p className="text-xs text-gray-500">30 questions • 60 min</p>
          </button>
          <button onClick={onGoLearn} className="group bg-white rounded-2xl p-5 shadow-md hover:shadow-xl border-2 border-gray-100 hover:border-green-300 transition-all hover:-translate-y-1 text-left">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center text-xl mb-3 shadow-md group-hover:scale-110 transition-transform">📖</div>
            <h3 className="text-base font-bold text-gray-800 mb-1">Learn</h3>
            <p className="text-xs text-gray-500">Notes + videos</p>
          </button>
          <button onClick={onGoProgress} className="group bg-white rounded-2xl p-5 shadow-md hover:shadow-xl border-2 border-gray-100 hover:border-blue-300 transition-all hover:-translate-y-1 text-left">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-xl mb-3 shadow-md group-hover:scale-110 transition-transform">📊</div>
            <h3 className="text-base font-bold text-gray-800 mb-1">Progress</h3>
            <p className="text-xs text-gray-500">Track results</p>
          </button>
          <button onClick={onGoMultiQuiz} className="group bg-white rounded-2xl p-5 shadow-md hover:shadow-xl border-2 border-gray-100 hover:border-pink-300 transition-all hover:-translate-y-1 text-left">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center text-xl mb-3 shadow-md group-hover:scale-110 transition-transform">🎮</div>
            <h3 className="text-base font-bold text-gray-800 mb-1">Quiz</h3>
            <p className="text-xs text-gray-500">Multiplayer battle!</p>
          </button>
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ACCOUNT CARD COMPONENTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function AccountCard({ account, showEmail = false }: { account: PublicAccount; showEmail?: boolean }) {
  return (
    <div className="bg-[#0b1020] text-white rounded-3xl shadow-2xl overflow-hidden border border-white/10">
      <div className="h-28 bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500 relative">
        <div className="absolute inset-0 opacity-20 text-7xl flex items-center justify-around">✨ 🎓 📚</div>
      </div>
      <div className="px-6 pb-6 -mt-16 relative">
        <div className="flex flex-col sm:flex-row items-center sm:items-end gap-4">
          <div className="w-32 h-32 rounded-3xl bg-gray-900 border-4 border-white/20 flex items-center justify-center shadow-xl">
            <MiniBlynk blynk={account.blynk} size={110} />
          </div>
          <div className="text-center sm:text-left pb-2">
            <h2 className="text-2xl font-extrabold">{account.name}</h2>
            <p className="text-gray-400 text-sm">{showEmail ? (account.email || 'Guest Account') : blurEmail(account.email)}</p>
            <p className="text-xs text-gray-500 mt-1">Joined {account.joined}</p>
          </div>
          <div className="flex-1" />
          <div className="bg-yellow-400/20 border border-yellow-300/30 text-yellow-200 rounded-xl px-4 py-2 font-bold mb-2">🪙 {account.coins}</div>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-6">
          <div className="bg-white/10 rounded-2xl p-4 text-center"><div className="text-2xl font-extrabold">{account.testsTaken}</div><div className="text-xs text-gray-400">Tests</div></div>
          <div className="bg-white/10 rounded-2xl p-4 text-center"><div className="text-2xl font-extrabold">{account.avgScore}%</div><div className="text-xs text-gray-400">Average</div></div>
          <div className="bg-white/10 rounded-2xl p-4 text-center"><div className="text-2xl font-extrabold">{account.bestScore}%</div><div className="text-xs text-gray-400">Best</div></div>
        </div>
        <div className="mt-5 bg-white/5 rounded-2xl p-4 border border-white/10">
          <p className="text-sm text-gray-300"><span className="font-bold text-white">Badge:</span> {account.bestScore >= 90 ? '🏆 CPEA Champion' : account.bestScore >= 75 ? '🌟 Rising Star' : account.testsTaken > 0 ? '📚 Practice Warrior' : '🌱 New Learner'}</p>
        </div>
      </div>
    </div>
  );
}

function AccountPage({ user, blynk, results, onBack }: { user: User; blynk: BlynkStyle; results: QuizResult[]; onBack: () => void }) {
  const [showEmail, setShowEmail] = useState(false);
  const testsTaken = results.length;
  const bestScore = testsTaken ? Math.max(...results.map(r => r.percentage)) : 0;
  const avgScore = testsTaken ? Math.round(results.reduce((a, r) => a + r.percentage, 0) / testsTaken) : 0;
  const account: PublicAccount = { id: user.id, name: user.name, email: user.email, coins: user.coins, blynk, joined: user.joined, testsTaken, bestScore, avgScore };
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-gray-900 to-black p-4">
      <div className="max-w-3xl mx-auto py-6">
        <button onClick={onBack} className="text-sm text-gray-300 hover:text-white mb-4">← back home</button>
        <div className="flex items-center justify-between gap-3 mb-6">
          <h1 className="text-3xl font-extrabold text-white">Your Account</h1>
          <button onClick={() => setShowEmail(v => !v)} className="bg-white/10 hover:bg-white/20 border border-white/20 text-white text-sm font-bold rounded-xl px-4 py-2">
            {showEmail ? '🙈 Blur Email' : '👁️ Show Email'}
          </button>
        </div>
        <AccountCard account={account} showEmail={showEmail} />
      </div>
    </div>
  );
}

function SearchAccountsPage({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState('');
  const [accounts, setAccounts] = useState<PublicAccount[]>(loadAccounts());
  const [loading, setLoading] = useState(false);
  const [cloudStatus, setCloudStatus] = useState('Loading global account directory...');

  useEffect(() => {
    setLoading(true);
    loadCloudAccounts().then(async globalAccounts => {
      if (globalAccounts.length > 0) {
        setAccounts(globalAccounts);
        setCloudStatus(`Showing ${globalAccounts.length} global account${globalAccounts.length === 1 ? '' : 's'}.`);
        setLoading(false);
        return;
      }

      // Optional Supabase fallback if configured, but the public MantleDB directory is the main global source.
      if (supabase) {
        const { data } = await supabase
          .from('profiles')
          .select('id,name,email,coins,blynk,created_at,tests_taken,best_score,avg_score')
          .limit(100);
        if (data && data.length > 0) {
          const mapped = data.map((p: any) => ({
            id: p.id,
            name: p.name || 'Student',
            email: p.email || '',
            coins: p.coins ?? 0,
            blynk: (p.blynk as BlynkStyle) || DEFAULT_BLYNK,
            joined: p.created_at ? new Date(p.created_at).toLocaleDateString() : 'Unknown',
            testsTaken: p.tests_taken ?? 0,
            bestScore: p.best_score ?? 0,
            avgScore: p.avg_score ?? 0,
          }));
          setAccounts(mapped);
          setCloudStatus(`Showing ${mapped.length} Supabase cloud account${mapped.length === 1 ? '' : 's'}.`);
          setLoading(false);
          return;
        }
      }

      const local = loadAccounts();
      setAccounts(local);
      setCloudStatus(local.length ? 'Global directory is empty right now, showing local accounts saved on this device.' : 'No global accounts yet. Create an account, reload, then it will appear here.');
      setLoading(false);
    });
  }, []);

  const filtered = accounts.filter(a => `${a.name} ${a.email}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-gray-900 to-black p-4">
      <div className="max-w-4xl mx-auto py-6">
        <button onClick={onBack} className="text-sm text-gray-300 hover:text-white mb-4">← back home</button>
        <h1 className="text-3xl font-extrabold text-white mb-2">Search Accounts</h1>
        <p className="text-gray-400 text-sm mb-5">Search all accounts made on this website. Emails stay blurred.</p>
        {cloudStatus && <div className="bg-blue-500/10 border border-blue-400/30 text-blue-200 rounded-2xl p-4 mb-5 text-sm">{cloudStatus}</div>}
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name or email..." className="w-full rounded-2xl bg-white/10 border border-white/20 text-white placeholder-gray-400 px-5 py-4 outline-none focus:border-pink-400 mb-6" />
        {loading ? (
          <div className="bg-white/10 border border-white/10 rounded-2xl p-10 text-center text-gray-400">Loading accounts...</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white/10 border border-white/10 rounded-2xl p-10 text-center text-gray-400">No accounts found.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {filtered.map(a => <AccountCard key={a.id} account={a} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PRACTICE SUBJECTS PAGE — only "Start Practice Test" buttons
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function PracticeSubjectsPage({ onStart, onBack }: { onStart: (s: Subject) => void; onBack: () => void }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 via-white to-purple-50">
      <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500 text-white">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <button onClick={onBack} className="text-sm text-indigo-200 hover:text-white mb-3">← back home</button>
          <h1 className="text-2xl md:text-3xl font-extrabold">Practice Tests 📝</h1>
          <p className="text-indigo-200 text-sm mt-1">30 random questions • 60 minutes • just like the real thing</p>
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {(['math', 'language', 'science', 'social'] as Subject[]).map(s => (
            <div key={s} className="bg-white rounded-2xl p-6 shadow-lg border border-gray-100 hover:shadow-xl transition-all hover:-translate-y-1">
              <div className={`inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br ${subjectInfo[s].color} items-center justify-center text-3xl mb-4 shadow-md`}>{subjectInfo[s].emoji}</div>
              <h3 className="text-xl font-bold text-gray-800 mb-1">{subjectInfo[s].name}</h3>
              <p className="text-sm text-gray-500 mb-5">{subjectInfo[s].desc}</p>
              <button onClick={() => onStart(s)} className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold text-sm transition-all shadow-md">
                <span>🚀 Start Practice Test</span><span>→</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LEARN SUBJECTS PAGE — only "Learn" buttons
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function LearnSubjectsPage({ onLearn, onBack }: { onLearn: (s: Subject) => void; onBack: () => void }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-green-50 via-white to-emerald-50">
      <div className="bg-gradient-to-r from-green-600 to-emerald-600 text-white">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <button onClick={onBack} className="text-sm text-green-200 hover:text-white mb-3">← back home</button>
          <h1 className="text-2xl md:text-3xl font-extrabold">Learn 📖</h1>
          <p className="text-green-200 text-sm mt-1">pick a subject to study notes & watch videos for each topic</p>
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {(['math', 'language', 'science', 'social'] as Subject[]).map(s => (
            <div key={s} className="bg-white rounded-2xl p-6 shadow-lg border border-gray-100 hover:shadow-xl transition-all hover:-translate-y-1">
              <div className={`inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br ${subjectInfo[s].color} items-center justify-center text-3xl mb-4 shadow-md`}>{subjectInfo[s].emoji}</div>
              <h3 className="text-xl font-bold text-gray-800 mb-1">{subjectInfo[s].name}</h3>
              <p className="text-sm text-gray-500 mb-3">{notesData[s].length} topics • notes + videos</p>
              <button onClick={() => onLearn(s)} className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-bold text-sm transition-all shadow-md">
                <span>📖 Start Learning</span><span>→</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUIZ START
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function QuizStartPage({ subject, onStart, onBack }: { subject: Subject; onStart: () => void; onBack: () => void }) {
  const info = subjectInfo[subject];
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl p-8 md:p-10 max-w-lg w-full text-center">
        <div className="text-6xl mb-4">{info.emoji}</div>
        <h2 className="text-2xl md:text-3xl font-extrabold text-gray-800 mb-2">{info.name}</h2>
        <p className="text-gray-500 mb-6">CPEA Practice Test</p>
        <div className="space-y-3 text-left bg-gray-50 rounded-xl p-5 mb-6 text-sm text-gray-700">
          <div className="flex items-center gap-3"><span className="bg-indigo-100 text-indigo-700 w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs">30</span>Multiple choice questions</div>
          <div className="flex items-center gap-3"><span className="bg-indigo-100 text-indigo-700 w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs">60</span>Minutes time limit</div>
          <div className="flex items-center gap-3"><span className="bg-indigo-100 text-indigo-700 w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs">A-C</span>Three options per question</div>
        </div>
        <button onClick={onStart} className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold rounded-xl px-6 py-4 text-lg shadow-lg hover:shadow-xl transition-all">🚀 Start Test</button>
        <button onClick={onBack} className="mt-3 text-sm text-gray-400 hover:text-gray-600">Go Back</button>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// QUIZ VIEW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function QuizView({ questions, qIdx, setQIdx, answers, setAnswers, flagged, setFlagged, timeLeft, subject, onSubmit, onBack }: {
  questions: Question[]; qIdx: number; setQIdx: (i: number) => void;
  answers: Record<number, number>; setAnswers: (fn: (p: Record<number, number>) => Record<number, number>) => void;
  flagged: Set<number>; setFlagged: (fn: (p: Set<number>) => Set<number>) => void;
  timeLeft: number; subject: Subject; onSubmit: () => void; onBack: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const currentQ = questions[qIdx];
  const answeredCount = Object.keys(answers).length;
  const pct = (answeredCount / questions.length) * 100;
  const isLow = timeLeft < 300;
  const handleAnswer = (i: 0 | 1 | 2) => setAnswers(prev => ({ ...prev, [qIdx]: i }));
  const toggleFlag = () => setFlagged(prev => { const n = new Set(prev); if (n.has(qIdx)) n.delete(qIdx); else n.add(qIdx); return n; });

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-800">← Exit</button>
            <div className="flex items-center gap-2"><span className="text-lg">{subjectInfo[subject].emoji}</span><span className="font-bold text-gray-800 text-sm">{subjectInfo[subject].name}</span></div>
            <div className={`text-lg font-mono font-bold ${isLow ? 'text-red-600 animate-pulse' : 'text-indigo-600'}`}>{String(Math.floor(timeLeft / 60)).padStart(2, '0')}:{String(timeLeft % 60).padStart(2, '0')}</div>
          </div>
          <div className="flex items-center gap-3"><div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all" style={{ width: `${pct}%` }}></div></div><span className="text-xs text-gray-500 font-medium">{answeredCount}/{questions.length}</span></div>
        </div>
      </div>
      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 mb-6">
          <div className="flex flex-wrap gap-1">
            {questions.map((_, i) => (
              <button key={i} onClick={() => setQIdx(i)}
                className={`w-8 h-8 rounded-md text-xs font-medium transition-all ${i === qIdx ? 'bg-indigo-600 text-white ring-2 ring-indigo-300 scale-110' : answers[i] !== undefined ? flagged.has(i) ? 'bg-yellow-400 text-yellow-900' : 'bg-indigo-100 text-indigo-700' : flagged.has(i) ? 'bg-yellow-100 text-yellow-700 border border-yellow-300' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>{i + 1}</button>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-500 to-purple-500 px-6 py-4 flex items-center justify-between">
            <span className="text-white font-bold text-lg">Question {qIdx + 1}</span>
            <button onClick={toggleFlag} className={`text-sm px-3 py-1.5 rounded-lg transition-all ${flagged.has(qIdx) ? 'bg-yellow-400 text-yellow-900 font-bold' : 'bg-white/20 text-white hover:bg-white/30'}`}>{flagged.has(qIdx) ? '⭐ Flagged' : '☆ Flag'}</button>
          </div>
          <div className="p-6">
            <div className="text-lg text-gray-800 font-medium mb-4 leading-relaxed whitespace-pre-line">{currentQ.question}</div>
            {currentQ.image && <div className="mb-6 flex justify-center"><img src={currentQ.image} alt="Diagram" className="max-w-xs max-h-48 rounded-xl shadow-md border border-gray-200" /></div>}
            <div className="space-y-3">
              {(['A', 'B', 'C'] as const).map((letter, i) => {
                const sel = answers[qIdx] === i;
                return (
                  <button key={letter} onClick={() => handleAnswer(i as 0 | 1 | 2)}
                    className={`w-full text-left flex items-center gap-4 px-5 py-4 rounded-xl border-2 transition-all ${sel ? 'border-indigo-500 bg-indigo-50 shadow-md' : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50/50'}`}>
                    <span className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all ${sel ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{letter}</span>
                    <span className={`font-medium ${sel ? 'text-indigo-800' : 'text-gray-700'}`}>{currentQ.options[i]}</span>
                    {sel && <svg className="w-5 h-5 text-indigo-600 ml-auto" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
            <button onClick={() => setQIdx(qIdx - 1)} disabled={qIdx === 0} className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-white border border-gray-200 text-gray-700 font-medium hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-all">← Previous</button>
            {qIdx === questions.length - 1 ? (
              <button onClick={() => setShowConfirm(true)} className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 text-white font-bold hover:from-green-600 hover:to-emerald-600 shadow-md">Submit Test ✓</button>
            ) : (
              <button onClick={() => setQIdx(qIdx + 1)} className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-all">Next →</button>
            )}
          </div>
        </div>
      </div>
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
            <div className="text-5xl mb-3">📝</div>
            <h3 className="text-xl font-bold text-gray-800">Submit your test?</h3>
            <p className="text-gray-500 mt-1">You've answered {answeredCount} of {questions.length}.</p>
            {answeredCount < questions.length && <p className="text-amber-600 text-sm mt-2 font-medium">⚠️ {questions.length - answeredCount} unanswered!</p>}
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowConfirm(false)} className="flex-1 px-4 py-3 rounded-xl border-2 border-gray-200 text-gray-700 font-medium hover:bg-gray-50">Go Back</button>
              <button onClick={onSubmit} className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-green-500 to-emerald-500 text-white font-bold hover:from-green-600 hover:to-emerald-600 shadow-md">Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RESULTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ResultsView({ result, onRetake, onChangeSubject }: { result: QuizResult; onRetake: () => void; onChangeSubject: () => void }) {
  const { percentage: pct, score, total, timeUsed, subject } = result;
  const min = Math.floor(timeUsed / 60); const sec = timeUsed % 60;
  const grade = pct >= 90 ? { g: '⭐', label: 'Outstanding! You\'re a CPEA star!', emoji: '🏆', color: 'from-yellow-400 to-amber-500', bg: 'bg-amber-50' }
    : pct >= 75 ? { g: '🌟', label: 'Really good! Just a bit more!', emoji: '🌟', color: 'from-green-400 to-emerald-500', bg: 'bg-green-50' }
    : pct >= 60 ? { g: '👍', label: 'Solid effort! Keep going!', emoji: '👍', color: 'from-blue-400 to-indigo-500', bg: 'bg-blue-50' }
    : pct >= 50 ? { g: '📚', label: 'Not bad! Check the tips below!', emoji: '📚', color: 'from-orange-400 to-amber-500', bg: 'bg-orange-50' }
    : { g: '💪', label: 'Everyone starts somewhere! Try again!', emoji: '💪', color: 'from-red-400 to-pink-500', bg: 'bg-red-50' };

  const tips = getTips(subject, pct);

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 via-white to-purple-50">
      <div className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500 text-white"><div className="max-w-3xl mx-auto px-4 py-8 text-center"><h1 className="text-2xl md:text-3xl font-extrabold mb-1">Test Results 📊</h1><p className="text-indigo-200 text-sm">{subjectInfo[subject].emoji} {subjectInfo[subject].name}</p></div></div>
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className={`rounded-3xl shadow-xl overflow-hidden ${grade.bg} border border-gray-100`}>
          <div className="bg-white p-8 md:p-10 text-center">
            <div className="text-6xl mb-3">{grade.emoji}</div>
            <div className={`inline-block bg-gradient-to-r ${grade.color} text-white font-extrabold text-3xl px-6 py-3 rounded-2xl mb-3 shadow-lg`}>{pct}%</div>
            <p className="text-lg font-bold text-gray-800 mb-1">{grade.label}</p>
            <div className="grid grid-cols-4 gap-3 mt-8">
              <div className="bg-green-50 rounded-xl p-4"><div className="text-2xl font-extrabold text-green-600">{score}</div><div className="text-xs text-green-700 font-medium">Correct</div></div>
              <div className="bg-red-50 rounded-xl p-4"><div className="text-2xl font-extrabold text-red-600">{total - score}</div><div className="text-xs text-red-700 font-medium">Wrong</div></div>
              <div className="bg-blue-50 rounded-xl p-4"><div className="text-2xl font-extrabold text-blue-600">{min}m {sec}s</div><div className="text-xs text-blue-700 font-medium">Time</div></div>
              <div className="bg-yellow-50 rounded-xl p-4"><div className="text-2xl font-extrabold text-yellow-600">+{5 + score} 🪙</div><div className="text-xs text-yellow-700 font-medium">Coins Earned</div></div>
            </div>
          </div>
        </div>
        <div className="mt-6 bg-white rounded-2xl shadow-md border border-gray-100 p-6">
          <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">💡 Tips to Improve</h3>
          <div className="space-y-3">{tips.map((tip, i) => (
            <div key={i} className="flex items-start gap-3 bg-gray-50 rounded-xl p-4"><span className="text-green-500 font-bold text-lg mt-0.5">✓</span><div><p className="font-medium text-gray-800 text-sm">{tip.title}</p><p className="text-gray-600 text-sm mt-0.5">{tip.desc}</p></div></div>
          ))}</div>
        </div>
        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <button onClick={onRetake} className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold rounded-xl px-6 py-4 shadow-lg transition-all">🔄 Retake (New Questions)</button>
          <button onClick={onChangeSubject} className="flex-1 bg-white border-2 border-indigo-200 text-indigo-700 font-bold rounded-xl px-6 py-4 hover:bg-indigo-50 transition-all shadow-md">📚 Another Subject</button>
        </div>
      </div>
    </div>
  );
}

function getTips(subject: Subject, pct: number): { title: string; desc: string }[] {
  const common = pct < 50 ? [{ title: 'Start with the Learn section', desc: 'Go through the notes and videos for your subject. They cover everything you need.' }] : [];
  const tipsMap: Record<Subject, Record<string, { title: string; desc: string }[]>> = {
    math: {
      low: [{ title: 'Master times tables', desc: 'Know multiplication facts up to 12×12 — it saves so much time.' }, { title: 'Practice fractions daily', desc: '5 fraction problems every day. Add, subtract, multiply, convert.' }, { title: 'Learn formulas', desc: 'Area, perimeter, volume — write them on a poster!' }],
      mid: [{ title: 'Work on word problems', desc: 'Underline key numbers first. Break the problem into steps.' }, { title: 'Time yourself', desc: 'Try 10 questions in 15 minutes to build speed.' }, { title: 'Check your answers', desc: 'Especially for percentage and ratio questions.' }],
      high: [{ title: 'Aim for perfection', desc: 'Focus on speed AND accuracy. Get all 30 right within 60 min.' }, { title: 'Challenge yourself', desc: 'Try doing tests with even less time.' }],
    },
    language: {
      low: [{ title: 'Read every day', desc: 'Anything — stories, news, instructions. Reading builds grammar naturally.' }, { title: 'Learn spelling rules', desc: '"i before e", plurals, doubling consonants — check the Learn section.' }, { title: 'Practice parts of speech', desc: 'Take any sentence and identify nouns, verbs, adjectives, adverbs.' }],
      mid: [{ title: 'Focus on tricky areas', desc: 'Which questions did you get wrong? Drill those specifically.' }, { title: 'Practice comprehension daily', desc: 'Read a short passage, write 3 questions, answer them.' }, { title: 'Learn figurative language', desc: 'Simile, metaphor, personification, alliteration — know them all.' }],
      high: [{ title: 'Polish punctuation', desc: 'Dialogue punctuation is where even good students lose marks.' }, { title: 'Read advanced texts', desc: 'Challenge yourself with harder material.' }],
    },
    science: {
      low: [{ title: 'Learn MRS GREN', desc: '7 characteristics of life: Movement, Respiration, Sensitivity, Growth, Reproduction, Excretion, Nutrition.' }, { title: 'Study one topic per day', desc: 'Don\'t cram. Master one topic before moving on.' }, { title: 'Draw diagrams', desc: 'Water cycle, plant parts, human body — visual learning helps.' }],
      mid: [{ title: 'Understand WHY', desc: 'Science is about reasons. Ask "why?" for every fact.' }, { title: 'Connect topics', desc: 'Photosynthesis → food chains → ecosystems. Everything links!' }, { title: 'Practice application', desc: 'Don\'t just know facts — apply them. "What happens if...?"' }],
      high: [{ title: 'Master the details', desc: 'Exact temperatures, numbers, definitions — nail the small stuff.' }, { title: 'Teach someone else', desc: 'Best way to solidify knowledge is to explain it.' }],
    },
    social: {
      low: [{ title: 'Study a Caribbean map', desc: 'Know Greater vs Lesser Antilles, capitals, island types.' }, { title: 'Create a timeline', desc: 'Indigenous → Columbus (1492) → Slavery → Emancipation (1838) → Independence.' }, { title: 'Study one topic at a time', desc: 'Pick from the Learn section and read carefully.' }],
      mid: [{ title: 'Memorize key dates', desc: '1492, 1834/1838, 1966 (Barbados), 1973 (CARICOM).' }, { title: 'Know government structure', desc: '3 branches and difference between rights and responsibilities.' }, { title: 'Connect culture to history', desc: 'Understand WHY Caribbean culture is the way it is.' }],
      high: [{ title: 'Know specific details', desc: 'Organization names (CARICOM, OECS), specific island features.' }, { title: 'Read current events', desc: 'Connecting textbook knowledge to real life helps.' }],
    },
  };
  return [...common, ...(tipsMap[subject][pct < 50 ? 'low' : pct < 75 ? 'mid' : 'high'] || [])];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LEARN TOPIC PAGE — YouTube video + notes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function LearnTopicPage({ subject, topic, onBack, onTopicSelect }: {
  subject: Subject; topic: string | null; onBack: () => void; onTopicSelect: (t: string) => void;
}) {
  const topics = notesData[subject];
  const activeTopic = (topic ? topics.find(t => t.id === topic) : topics[0])!;
  const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(activeTopic.videoQuery)}`;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-r from-green-600 to-emerald-600 text-white">
        <div className="max-w-5xl mx-auto px-4 py-6">
          <button onClick={onBack} className="text-sm text-green-200 hover:text-white mb-2">← back to subjects</button>
          <h1 className="text-2xl font-extrabold">{subjectInfo[subject].emoji} {subjectInfo[subject].name} — Learn</h1>
        </div>
      </div>
      <div className="max-w-5xl mx-auto px-4 py-6 flex flex-col lg:flex-row gap-6">
        {/* Topic sidebar */}
        <div className="lg:w-64 flex-shrink-0">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden sticky top-20">
            <div className="p-3 bg-gray-50 border-b border-gray-100"><span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Topics ({topics.length})</span></div>
            <div className="max-h-[60vh] overflow-y-auto">
              {topics.map(t => (
                <button key={t.id} onClick={() => onTopicSelect(t.id)}
                  className={`w-full text-left px-4 py-3 flex items-center gap-2 text-sm transition-all border-l-4 ${(activeTopic.id === t.id) ? 'border-green-500 bg-green-50 text-green-800 font-bold' : 'border-transparent text-gray-600 hover:bg-gray-50 hover:border-gray-300'}`}>
                  <span>{t.emoji}</span><span className="truncate">{t.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-6">
          {/* YouTube Video Link */}
          <a href={ytSearchUrl} target="_blank" rel="noopener noreferrer"
            className="block bg-white rounded-2xl shadow-md border border-gray-100 overflow-hidden hover:shadow-xl transition-all group">
            <div className="p-5 flex items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-red-500 to-red-600 flex items-center justify-center text-white text-3xl shadow-md group-hover:scale-110 transition-transform">▶</div>
              <div className="flex-1">
                <h3 className="font-bold text-gray-800 group-hover:text-red-600 transition-colors">🎬 Watch Video Lessons</h3>
                <p className="text-sm text-gray-500 mt-0.5">Search YouTube for "{activeTopic.title}"</p>
                <p className="text-xs text-red-500 font-medium mt-1">Opens in a new tab →</p>
              </div>
            </div>
          </a>

          {/* Notes */}
          <div className="bg-white rounded-2xl shadow-md border border-gray-100 p-6 md:p-8">
            <div className="flex items-center gap-3 mb-6">
              <span className="text-4xl">{activeTopic.emoji}</span>
              <h2 className="text-2xl font-bold text-gray-800">{activeTopic.title}</h2>
            </div>
            <div className="prose prose-sm max-w-none">
              {activeTopic.content.split('\n').map((line, i) => {
                if (line.startsWith('**') && line.includes('**')) {
                  const title = line.replace(/\*\*/g, '');
                  return <h3 key={i} className="text-base font-bold text-gray-800 mt-5 mb-2 border-l-4 border-green-400 pl-3">{title}</h3>;
                }
                if (line.startsWith('• ')) return <li key={i} className="text-gray-700 ml-4 mb-1">{line.slice(2)}</li>;
                if (line.trim() === '') return <br key={i} />;
                return <p key={i} className="text-gray-700 text-sm leading-relaxed mb-1">{line}</p>;
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROGRESS PAGE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ProgressPage({ results, onBack }: { results: QuizResult[]; onBack: () => void }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-r from-blue-600 to-cyan-600 text-white">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <button onClick={onBack} className="text-sm text-blue-200 hover:text-white mb-3">← back home</button>
          <h1 className="text-2xl md:text-3xl font-extrabold">your progress 📊</h1>
          <p className="text-blue-200 text-sm mt-1">all your test results in one place</p>
        </div>
      </div>
      <div className="max-w-4xl mx-auto px-4 py-8">
        {results.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
            <div className="text-5xl mb-4">📝</div>
            <h3 className="text-lg font-bold text-gray-800 mb-2">No tests taken yet!</h3>
            <p className="text-gray-500 text-sm">Take your first practice test to start tracking your progress.</p>
            <button onClick={onBack} className="mt-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold rounded-xl px-6 py-3 shadow-md">Take a Test</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 mb-6">
              <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center"><div className="text-2xl font-extrabold text-indigo-600">{results.length}</div><div className="text-xs text-gray-500 font-medium">Tests</div></div>
              <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center"><div className="text-2xl font-extrabold text-green-600">{Math.round(results.reduce((a, r) => a + r.percentage, 0) / results.length)}%</div><div className="text-xs text-gray-500 font-medium">Average</div></div>
              <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center"><div className="text-2xl font-extrabold text-amber-600">{Math.max(...results.map(r => r.percentage))}%</div><div className="text-xs text-gray-500 font-medium">Best</div></div>
            </div>
            {[...results].reverse().map((r) => (
              <div key={r.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex items-center gap-4">
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${subjectInfo[r.subject].color} flex items-center justify-center text-xl shadow-md flex-shrink-0`}>{subjectInfo[r.subject].emoji}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-gray-800">{subjectInfo[r.subject].name}</h4>
                    <span className={`text-lg font-extrabold ${r.percentage >= 75 ? 'text-green-600' : r.percentage >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{r.percentage}%</span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-gray-500">{r.date} • {Math.floor(r.timeUsed / 60)}m {r.timeUsed % 60}s</span>
                    <span className="text-xs text-gray-500">{r.score}/{r.total}</span>
                  </div>
                  <div className="mt-2 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${r.percentage >= 75 ? 'bg-green-500' : r.percentage >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${r.percentage}%` }}></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MINI BLYNK RENDERER  (fixed coordinate system 200×270)
//   Head centre  = (100, 115), radius = 58
//   Body top     = 165,  bottom = 255
//   Hat region   = 0 – 60  (well above head top at 57)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function MiniBlynk({ blynk, size = 100 }: { blynk: BlynkStyle; size?: number }) {
  // ── All coords in a 200×270 internal space, scaled via viewBox ──
  const hc  = blynk.color;       // head/skin colour
  const tc  = blynk.outfitColor; // outfit colour
  const ol  = '#2a1a0a';          // thick cartoon outline

  // Fixed anchor points
  const HX = 100, HY = 125, HR = 58; // head centre & radius
  const BT = HY + HR - 8;            // body top (overlaps head bottom slightly)
  const BB = 260;                     // body bottom

  /* ── EYES ── */
  const EY = HY - 8, ELX = HX - 22, ERX = HX + 22;
  const eyes = () => {
    const e = blynk.eyes;
    const s4 = 4, s8 = 8, s12 = 12;
    if (e==='Happy')    return <><path d={`M${ELX-s12} ${EY+s4} Q${ELX} ${EY-s12} ${ELX+s12} ${EY+s4}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/><path d={`M${ERX-s12} ${EY+s4} Q${ERX} ${EY-s12} ${ERX+s12} ${EY+s4}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/></>;
    if (e==='Sad')      return <><path d={`M${ELX-s12} ${EY-s4} Q${ELX} ${EY+s12} ${ELX+s12} ${EY-s4}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/><path d={`M${ERX-s12} ${EY-s4} Q${ERX} ${EY+s12} ${ERX+s12} ${EY-s4}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/></>;
    if (e==='Mad')      return <><line x1={ELX-s12} y1={EY-s4} x2={ELX+s12} y2={EY+s4} stroke={ol} strokeWidth="5" strokeLinecap="round"/><line x1={ERX-s12} y1={EY+s4} x2={ERX+s12} y2={EY-s4} stroke={ol} strokeWidth="5" strokeLinecap="round"/></>;
    if (e==='Bored')    return <><line x1={ELX-s12} y1={EY} x2={ELX+s12} y2={EY} stroke={ol} strokeWidth="5" strokeLinecap="round"/><line x1={ERX-s12} y1={EY} x2={ERX+s12} y2={EY} stroke={ol} strokeWidth="5" strokeLinecap="round"/></>;
    if (e==='Wink')     return <><path d={`M${ELX-s12} ${EY+s4} Q${ELX} ${EY-s12} ${ELX+s12} ${EY+s4}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/><line x1={ERX-s12} y1={EY} x2={ERX+s12} y2={EY} stroke={ol} strokeWidth="5" strokeLinecap="round"/></>;
    if (e==='Surprised') return <><circle cx={ELX} cy={EY} r={s8} fill={ol}/><circle cx={ELX+3} cy={EY-3} r="3" fill="#fff"/><circle cx={ERX} cy={EY} r={s8} fill={ol}/><circle cx={ERX+3} cy={EY-3} r="3" fill="#fff"/></>;
    if (e==='Closed')   return <><line x1={ELX-s12} y1={EY} x2={ELX+s12} y2={EY} stroke={ol} strokeWidth="5" strokeLinecap="round"/><line x1={ERX-s12} y1={EY} x2={ERX+s12} y2={EY} stroke={ol} strokeWidth="5" strokeLinecap="round"/></>;
    if (e==='Derp')     return <><circle cx={ELX} cy={EY} r={s8} fill={ol}/><circle cx={ELX+3} cy={EY-3} r="3" fill="#fff"/><line x1={ERX-s12} y1={EY} x2={ERX+s12} y2={EY} stroke={ol} strokeWidth="5" strokeLinecap="round"/></>;
    if (e==='Hearts')   return <><text x={ELX} y={EY+5} textAnchor="middle" fontSize="18" fill="#ef4444">♥</text><text x={ERX} y={EY+5} textAnchor="middle" fontSize="18" fill="#ef4444">♥</text></>;
    // Normal
    return <><line x1={ELX} y1={EY-s8} x2={ELX} y2={EY+s8} stroke={ol} strokeWidth="6" strokeLinecap="round"/><line x1={ERX} y1={EY-s8} x2={ERX} y2={EY+s8} stroke={ol} strokeWidth="6" strokeLinecap="round"/></>;
  };

  /* ── MOUTH ── */
  const MY = HY + 20;
  const mouth = () => {
    const m = blynk.mouth;
    if (m==='Big Smile') return <path d={`M${HX-28} ${MY} Q${HX} ${MY+30} ${HX+28} ${MY}`} fill="none" stroke={ol} strokeWidth="6" strokeLinecap="round"/>;
    if (m==='Tongue')    return <><path d={`M${HX-18} ${MY} Q${HX} ${MY+16} ${HX+18} ${MY}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/><ellipse cx={HX+8} cy={MY+18} rx="8" ry="10" fill="#f87171" stroke={ol} strokeWidth="3"/></>;
    if (m==='Wavy')      return <path d={`M${HX-22} ${MY} Q${HX-11} ${MY+12} ${HX} ${MY} Q${HX+11} ${MY+12} ${HX+22} ${MY}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/>;
    if (m==='Frown')     return <path d={`M${HX-20} ${MY+10} Q${HX} ${MY} ${HX+20} ${MY+10}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/>;
    if (m==='Straight')  return <line x1={HX-20} y1={MY+4} x2={HX+20} y2={MY+4} stroke={ol} strokeWidth="5" strokeLinecap="round"/>;
    if (m==='Open')      return <ellipse cx={HX} cy={MY+6} rx="14" ry="12" fill={ol}/>;
    if (m==='Smirk')     return <path d={`M${HX-10} ${MY+8} Q${HX+10} ${MY+4} ${HX+22} ${MY}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/>;
    if (m==='Teeth')     return <><path d={`M${HX-22} ${MY} Q${HX} ${MY+22} ${HX+22} ${MY} Z`} fill={ol}/><rect x={HX-18} y={MY} width="36" height="9" fill="#fff" rx="2"/></>;
    if (m==='Ooo')       return <ellipse cx={HX} cy={MY+6} rx="9" ry="12" fill={ol}/>;
    if (m==='Cat')       return <><path d={`M${HX-14} ${MY+8} Q${HX-6} ${MY+2} ${HX} ${MY+8} Q${HX+6} ${MY+2} ${HX+14} ${MY+8}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/><circle cx={HX} cy={MY-2} r="4" fill={ol}/></>;
    if (m==='Side')      return <path d={`M${HX-6} ${MY+6} Q${HX+10} ${MY+12} ${HX+18} ${MY+2}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/>;
    // Smile (default)
    return <path d={`M${HX-22} ${MY} Q${HX} ${MY+22} ${HX+22} ${MY}`} fill="none" stroke={ol} strokeWidth="5" strokeLinecap="round"/>;
  };

  /* ── ACCESSORIES (drawn ON top of head/face) ── */
  const acc = () => {
    const a = blynk.accessory;
    const EYbase = HY - 8;
    if (a==='Blush')         return <><ellipse cx={ELX-4} cy={EYbase+20} rx="14" ry="9" fill="#f9a8d4" opacity="0.65"/><ellipse cx={ERX+4} cy={EYbase+20} rx="14" ry="9" fill="#f9a8d4" opacity="0.65"/></>;
    if (a==='Shades')        return <><rect x={ELX-18} y={EYbase-10} width="34" height="20" rx="5" fill="#111"/><rect x={ERX-16} y={EYbase-10} width="34" height="20" rx="5" fill="#111"/><line x1={ELX+16} y1={EYbase} x2={ERX-16} y2={EYbase} stroke="#111" strokeWidth="4"/><line x1={HX-58} y1={EYbase} x2={ELX-18} y2={EYbase} stroke="#111" strokeWidth="3"/><line x1={ERX+18} y1={EYbase} x2={HX+58} y2={EYbase} stroke="#111" strokeWidth="3"/></>;
    if (a==='Nerdy Glasses') return <><circle cx={ELX} cy={EYbase} r="16" fill="none" stroke={ol} strokeWidth="4"/><circle cx={ERX} cy={EYbase} r="16" fill="none" stroke={ol} strokeWidth="4"/><line x1={ELX+16} y1={EYbase} x2={ERX-16} y2={EYbase} stroke={ol} strokeWidth="3"/><line x1={HX-58} y1={EYbase} x2={ELX-16} y2={EYbase} stroke={ol} strokeWidth="3"/><line x1={ERX+16} y1={EYbase} x2={HX+58} y2={EYbase} stroke={ol} strokeWidth="3"/></>;
    if (a==='Heart Glasses') return <><text x={ELX} y={EYbase+8} textAnchor="middle" fontSize="26" fill="#ef4444">♥</text><text x={ERX} y={EYbase+8} textAnchor="middle" fontSize="26" fill="#ef4444">♥</text><line x1={HX-58} y1={EYbase} x2={ELX-16} y2={EYbase} stroke="#ef4444" strokeWidth="3"/><line x1={ERX+16} y1={EYbase} x2={HX+58} y2={EYbase} stroke="#ef4444" strokeWidth="3"/></>;
    if (a==='Gold Chain')    return <path d={`M${HX-30} ${BT+25} C${HX-30} ${BT+50} ${HX+30} ${BT+50} ${HX+30} ${BT+25}`} fill="none" stroke="#facc15" strokeWidth="5" strokeLinecap="round" strokeDasharray="6 5"/>;
    if (a==='Bowtie')        return <><polygon points={`${HX-20},${BT+5} ${HX},${BT+18} ${HX+20},${BT+5} ${HX+20},${BT+28} ${HX},${BT+18} ${HX-20},${BT+28}`} fill="#ef4444" stroke={ol} strokeWidth="3" strokeLinejoin="round"/><circle cx={HX} cy={BT+16} r="5" fill={ol}/></>;
    if (a==='Freckles')      return <><circle cx={ELX-10} cy={HY+22} r="3.5" fill="#a16207" opacity="0.7"/><circle cx={ELX-2} cy={HY+28} r="3" fill="#a16207" opacity="0.7"/><circle cx={ERX+10} cy={HY+22} r="3.5" fill="#a16207" opacity="0.7"/><circle cx={ERX+2} cy={HY+28} r="3" fill="#a16207" opacity="0.7"/></>;
    if (a==='Scar')          return <><path d={`M${ELX-8} ${HY-24} L${ELX+8} ${HY+2}`} fill="none" stroke="#dc2626" strokeWidth="5" strokeLinecap="round"/><path d={`M${ELX-4} ${HY-22} L${ELX+4} ${HY+0}`} fill="none" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/></>;
    if (a==='Monocle')       return <><circle cx={ERX} cy={EYbase} r="18" fill="none" stroke="#b45309" strokeWidth="4"/><line x1={ERX+16} y1={EYbase+10} x2={ERX+24} y2={BT-4} stroke="#b45309" strokeWidth="3"/></>;
    return null;
  };

  /* ── OUTFIT (body, drawn first / behind head) ── */
  const outfit = () => {
    const o = blynk.outfitType;
    const bw = 72; // half body width at top
    // Base torso shape: trapezoid widening downward
    const body = `M${HX-bw} ${BB} C${HX-bw} ${BT+40} ${HX-bw+10} ${BT+4} ${HX-30} ${BT} L${HX+30} ${BT} C${HX+bw-10} ${BT+4} ${HX+bw} ${BT+40} ${HX+bw} ${BB} Z`;

    if (o==='Overalls') return <g>
      <path d={body} fill="#e2e8f0" stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <path d={`M${HX-bw} ${BB} L${HX-bw} ${BT+80} Q${HX} ${BT+90} ${HX+bw} ${BT+80} L${HX+bw} ${BB} Z`} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <rect x={HX-28} y={BT+10} width="20" height="50" rx="6" fill={tc} stroke={ol} strokeWidth="4"/>
      <rect x={HX+8} y={BT+10} width="20" height="50" rx="6" fill={tc} stroke={ol} strokeWidth="4"/>
      <circle cx={HX-18} cy={BT+65} r="7" fill={ol}/>
      <circle cx={HX+18} cy={BT+65} r="7" fill={ol}/>
    </g>;

    if (o==='Cape') return <g>
      <path d={body} fill={hc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <path d={`M${HX-24} ${BT+15} C${HX-90} ${BT+50} ${HX-85} ${BB} ${HX-10} ${BB} L${HX-10} ${BT+15} Z`} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <path d={`M${HX+24} ${BT+15} C${HX+90} ${BT+50} ${HX+85} ${BB} ${HX+10} ${BB} L${HX+10} ${BT+15} Z`} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <circle cx={HX} cy={BT+20} r="10" fill={tc} stroke={ol} strokeWidth="4"/>
    </g>;

    if (o==='Jacket') return <g>
      <path d={body} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      {/* Lapels */}
      <path d={`M${HX-30} ${BT} L${HX-14} ${BT+60} L${HX} ${BT+30} Z`} fill="#fff" stroke={ol} strokeWidth="4" strokeLinejoin="round"/>
      <path d={`M${HX+30} ${BT} L${HX+14} ${BT+60} L${HX} ${BT+30} Z`} fill="#fff" stroke={ol} strokeWidth="4" strokeLinejoin="round"/>
      <line x1={HX} y1={BT+30} x2={HX} y2={BB} stroke={ol} strokeWidth="3"/>
    </g>;

    if (o==='Dress') return <g>
      <path d={`M${HX-40} ${BT} L${HX-bw-20} ${BB} L${HX+bw+20} ${BB} L${HX+40} ${BT} Z`} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <rect x={HX-30} y={BT-4} width="60" height="30" rx="6" fill={tc} stroke={ol} strokeWidth="5"/>
      <line x1={HX-bw} y1={BT+80} x2={HX+bw} y2={BT+80} stroke={ol} strokeWidth="3" opacity="0.3"/>
    </g>;

    if (o==='Tank Top') return <g>
      <path d={body} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      {/* Thin straps */}
      <rect x={HX-30} y={BT-10} width="14" height="24" rx="4" fill={tc} stroke={ol} strokeWidth="4"/>
      <rect x={HX+16} y={BT-10} width="14" height="24" rx="4" fill={tc} stroke={ol} strokeWidth="4"/>
    </g>;

    if (o==='Turtleneck') return <g>
      <path d={body} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      {/* High neck */}
      <rect x={HX-28} y={BT-16} width="56" height="34" rx="14" fill={tc} stroke={ol} strokeWidth="5"/>
    </g>;

    if (o==='Suit') return <g>
      <path d={body} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      {/* White shirt strip */}
      <rect x={HX-10} y={BT} width="20" height={BB-BT} fill="#f1f5f9"/>
      {/* Lapels */}
      <path d={`M${HX-30} ${BT} L${HX-8} ${BT+55} L${HX} ${BT+25} Z`} fill="#e2e8f0" stroke={ol} strokeWidth="3" strokeLinejoin="round"/>
      <path d={`M${HX+30} ${BT} L${HX+8} ${BT+55} L${HX} ${BT+25} Z`} fill="#e2e8f0" stroke={ol} strokeWidth="3" strokeLinejoin="round"/>
      {/* Buttons */}
      <circle cx={HX} cy={BT+60} r="5" fill={ol}/><circle cx={HX} cy={BT+85} r="5" fill={ol}/>
    </g>;

    if (o==='Polo') return <g>
      <path d={body} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <path d={`M${HX-22} ${BT} L${HX} ${BT+36} L${HX+22} ${BT} L${HX+12} ${BT-2} L${HX-12} ${BT-2} Z`} fill="#fff" stroke={ol} strokeWidth="4" strokeLinejoin="round"/>
      <line x1={HX} y1={BT+36} x2={HX} y2={BT+58} stroke={ol} strokeWidth="3"/>
    </g>;

    // Hoodie (default + T-Shirt)
    return <g>
      <path d={body} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      {o==='Hoodie' && <>
        {/* Hood roll at top */}
        <path d={`M${HX-bw+4} ${BT+6} C${HX-bw+4} ${BT-18} ${HX+bw-4} ${BT-18} ${HX+bw-4} ${BT+6}`} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
        {/* Pocket */}
        <path d={`M${HX-28} ${BT+105} L${HX-22} ${BT+75} L${HX+22} ${BT+75} L${HX+28} ${BT+105} Z`} fill="none" stroke={ol} strokeWidth="4" strokeLinejoin="round"/>
        {/* Drawstrings */}
        <line x1={HX-14} y1={BT+14} x2={HX-14} y2={BT+45} stroke="#fff" strokeWidth="4" strokeLinecap="round"/>
        <line x1={HX+14} y1={BT+14} x2={HX+14} y2={BT+45} stroke="#fff" strokeWidth="4" strokeLinecap="round"/>
      </>}
    </g>;
  };

  /* ── HATS (all positioned to sit atop the head; head top = HY-HR = 67) ── */
  const hat = () => {
    const h = blynk.hat;
    const TOP = HY - HR; // y = 67 — top of head circle
    if (h==='Crown') return <g>
      <path d={`M${HX-38} ${TOP+16} L${HX-48} ${TOP-22} L${HX-12} ${TOP-2} L${HX} ${TOP-30} L${HX+12} ${TOP-2} L${HX+48} ${TOP-22} L${HX+38} ${TOP+16} Z`} fill="#facc15" stroke="#92400e" strokeWidth="5" strokeLinejoin="round"/>
      <circle cx={HX} cy={TOP-28} r="7" fill="#ef4444"/>
      <circle cx={HX-48} cy={TOP-20} r="5" fill="#ef4444"/>
      <circle cx={HX+48} cy={TOP-20} r="5" fill="#ef4444"/>
    </g>;
    if (h==='Cat Beanie') return <g>
      <path d={`M${HX-50} ${TOP+14} C${HX-50} ${TOP-18} ${HX+50} ${TOP-18} ${HX+50} ${TOP+14} Z`} fill="#f1f5f9" stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      {/* Cat ears */}
      <path d={`M${HX-44} ${TOP-14} L${HX-52} ${TOP-42} L${HX-26} ${TOP-14} Z`} fill="#f1f5f9" stroke={ol} strokeWidth="4" strokeLinejoin="round"/>
      <path d={`M${HX+44} ${TOP-14} L${HX+52} ${TOP-42} L${HX+26} ${TOP-14} Z`} fill="#f1f5f9" stroke={ol} strokeWidth="4" strokeLinejoin="round"/>
      <path d={`M${HX-42} ${TOP-17} L${HX-48} ${TOP-38} L${HX-28} ${TOP-17} Z`} fill="#f9a8d4" strokeWidth="0"/>
      <path d={`M${HX+42} ${TOP-17} L${HX+48} ${TOP-38} L${HX+28} ${TOP-17} Z`} fill="#f9a8d4" strokeWidth="0"/>
    </g>;
    if (h==='Dog Beanie') return <g>
      <path d={`M${HX-50} ${TOP+14} C${HX-50} ${TOP-18} ${HX+50} ${TOP-18} ${HX+50} ${TOP+14} Z`} fill="#d97706" stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      {/* Floppy ears */}
      <ellipse cx={HX-52} cy={TOP+10} rx="16" ry="28" fill="#a16207" stroke={ol} strokeWidth="4"/>
      <ellipse cx={HX+52} cy={TOP+10} rx="16" ry="28" fill="#a16207" stroke={ol} strokeWidth="4"/>
    </g>;
    if (h==='Safari Hat') return <g>
      <ellipse cx={HX} cy={TOP+12} rx="66" ry="14" fill="#eab308" stroke={ol} strokeWidth="5"/>
      <path d={`M${HX-40} ${TOP+12} C${HX-38} ${TOP-28} ${HX+38} ${TOP-28} ${HX+40} ${TOP+12} Z`} fill="#facc15" stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <line x1={HX-36} y1={TOP+2} x2={HX+36} y2={TOP+2} stroke="#92400e" strokeWidth="3"/>
    </g>;
    if (h==='Leaf Sprout') return <g>
      <line x1={HX} y1={TOP+6} x2={HX+8} y2={TOP-44} stroke="#166534" strokeWidth="5" strokeLinecap="round"/>
      <path d={`M${HX+8} ${TOP-44} C${HX-24} ${TOP-70} ${HX-36} ${TOP-34} ${HX+4} ${TOP-20} C${HX+32} ${TOP-34} ${HX+36} ${TOP-70} ${HX+8} ${TOP-44} Z`} fill="#4ade80" stroke="#166534" strokeWidth="4" strokeLinejoin="round"/>
    </g>;
    if (h==='Top Hat') return <g>
      <rect x={HX-48} y={TOP+4} width="96" height="16" rx="6" fill="#1f2937" stroke={ol} strokeWidth="5"/>
      <rect x={HX-32} y={TOP-50} width="64" height="56" rx="8" fill="#1f2937" stroke={ol} strokeWidth="5"/>
      <rect x={HX-28} y={TOP-2} width="56" height="10" rx="4" fill="#dc2626"/>
    </g>;
    if (h==='Santa Cap') return <g>
      <path d={`M${HX-42} ${TOP+14} C${HX-20} ${TOP-10} ${HX+10} ${TOP-40} ${HX+40} ${TOP-80} L${HX+56} ${TOP-64} C${HX+30} ${TOP-36} ${HX+6} ${TOP-8} ${HX+42} ${TOP+14} Z`} fill="#ef4444" stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <ellipse cx={HX} cy={TOP+14} rx="48" ry="12" fill="#fff" stroke={ol} strokeWidth="4"/>
      <circle cx={HX+56} cy={TOP-64} r="12" fill="#fff" stroke={ol} strokeWidth="4"/>
    </g>;
    if (h==='Wizard Hat') return <g>
      <path d={`M${HX} ${TOP-80} L${HX-50} ${TOP+14} L${HX+50} ${TOP+14} Z`} fill="#6d28d9" stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <ellipse cx={HX} cy={TOP+14} rx="56" ry="13" fill="#7c3aed" stroke={ol} strokeWidth="4"/>
      <circle cx={HX-14} cy={TOP-28} r="5" fill="#facc15"/><circle cx={HX+20} cy={TOP-10} r="4" fill="#facc15"/><circle cx={HX+4} cy={TOP-54} r="4" fill="#facc15"/>
    </g>;
    if (h==='Party Hat') return <g>
      <path d={`M${HX} ${TOP-70} L${HX-36} ${TOP+14} L${HX+36} ${TOP+14} Z`} fill="#f472b6" stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <circle cx={HX} cy={TOP-70} r="8" fill="#facc15" stroke={ol} strokeWidth="3"/>
      <line x1={HX-30} y1={TOP-4} x2={HX+30} y2={TOP-4} stroke="#facc15" strokeWidth="3" strokeDasharray="5 4"/>
    </g>;
    if (h==='Baseball Cap') return <g>
      <path d={`M${HX-48} ${TOP+14} C${HX-46} ${TOP-20} ${HX+46} ${TOP-20} ${HX+48} ${TOP+14} Z`} fill={tc} stroke={ol} strokeWidth="5" strokeLinejoin="round"/>
      <ellipse cx={HX} cy={TOP+14} rx="52" ry="11" fill={tc} stroke={ol} strokeWidth="4"/>
      {/* Brim */}
      <path d={`M${HX-52} ${TOP+14} Q${HX-42} ${TOP+34} ${HX+52} ${TOP+14}`} fill={tc} stroke={ol} strokeWidth="4"/>
    </g>;
    if (h==='Halo') return <g>
      <ellipse cx={HX} cy={TOP-10} rx="44" ry="12" fill="none" stroke="#facc15" strokeWidth="8" opacity="0.9"/>
      <ellipse cx={HX} cy={TOP-10} rx="44" ry="12" fill="none" stroke="#fef08a" strokeWidth="4" opacity="0.6"/>
    </g>;
    return null;
  };

  return (
    <svg width={size} height={size} viewBox="0 0 200 270" className="overflow-visible" style={{filter:'drop-shadow(0 4px 8px rgba(0,0,0,0.25))'}}>
      {outfit()}
      <circle cx={HX} cy={HY} r={HR} fill={hc} stroke={ol} strokeWidth="5"/>
      {eyes()}
      {mouth()}
      {acc()}
      {hat()}
    </svg>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BLYNK CUSTOMIZE PAGE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function BlynkCustomizePage({ blynk, onSave, onBack }: { blynk: BlynkStyle; onSave: (b: BlynkStyle) => void; onBack: () => void }) {
  const [style, setStyle] = useState<BlynkStyle>(blynk);
  const update = (cat: keyof BlynkStyle, val: string) => setStyle(prev => ({ ...prev, [cat]: val }));
  const cats: { key: keyof BlynkStyle; label: string; emoji: string }[] = [
    { key: 'color', label: 'Skin Color', emoji: '🎨' }, { key: 'eyes', label: 'Eyes', emoji: '👀' },
    { key: 'mouth', label: 'Mouth', emoji: '👄' }, { key: 'outfitType', label: 'Outfit Type', emoji: '👕' },
    { key: 'outfitColor', label: 'Outfit Color', emoji: '🌈' }, { key: 'hat', label: 'Hats', emoji: '🎩' },
    { key: 'accessory', label: 'Extras', emoji: '💎' },
  ];
  const isColor = (cat: string) => cat === 'color' || cat === 'outfitColor';
  
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 font-sans selection:bg-blue-500/30">
      {/* Topbar */}
      <div className="bg-gray-800 border-b border-gray-700 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center hover:bg-gray-600 transition-colors">←</button>
          <h1 className="text-xl font-bold text-white">Blynk Studio</h1>
        </div>
        <button onClick={() => onSave(style)} className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-2 rounded-lg transition-colors">Save Changes</button>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8 flex flex-col md:flex-row gap-6">
        {/* Preview Panel */}
        <div className="md:w-[400px] flex-shrink-0">
          <div className="bg-gray-800 rounded-2xl border border-gray-700 p-8 text-center sticky top-8 flex flex-col items-center">
            <p className="text-xs font-bold text-gray-400 tracking-widest mb-8 uppercase">YOUR BLYNK</p>
            <div className="mb-10"><MiniBlynk blynk={style} size={240} /></div>
            <div className="w-full flex gap-3">
              <button onClick={() => {
                const r = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
                setStyle({ color: r(BLYNK_OPTIONS.color), eyes: r(BLYNK_OPTIONS.eyes), mouth: r(BLYNK_OPTIONS.mouth), outfitType: r(BLYNK_OPTIONS.outfitType), outfitColor: r(BLYNK_OPTIONS.outfitColor), hat: r(BLYNK_OPTIONS.hat), accessory: r(BLYNK_OPTIONS.accessory) });
              }} className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-200 py-3 rounded-xl font-medium transition-colors">⚄ Randomize</button>
              <button onClick={() => setStyle(blynk)} className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-200 py-3 rounded-xl font-medium transition-colors">↺ Reset</button>
            </div>
            <div className="mt-6 bg-yellow-500/10 border border-yellow-500/20 text-yellow-200 text-sm rounded-xl p-4 text-left flex gap-3">
              <span>ⓘ</span><div><p className="font-bold mb-1">Customize Your Blynk</p><p className="text-xs opacity-80">This is how you will appear in multiplayer quizzes. Save when you're done!</p></div>
            </div>
          </div>
        </div>

        {/* Options Panel */}
        <div className="flex-1 bg-gray-800 rounded-2xl border border-gray-700 p-6 md:p-8">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
            {cats.map(cat => (
              <a key={cat.key} href={`#${cat.key}`} className="bg-gray-700/50 hover:bg-gray-700 border border-gray-600 rounded-xl p-4 text-center transition-colors">
                <div className="text-2xl mb-2">{cat.emoji}</div>
                <div className="text-sm font-medium text-gray-300">{cat.label}</div>
              </a>
            ))}
          </div>

          <div className="space-y-10">
            {cats.map(cat => (
              <div key={cat.key} id={cat.key} className="pt-4 border-t border-gray-700">
                <h3 className="font-bold text-gray-200 mb-4">{cat.label}</h3>
                <div className="flex flex-wrap gap-3">
                  {BLYNK_OPTIONS[cat.key].map(opt => {
                    const active = style[cat.key] === opt;
                    if (isColor(cat.key)) {
                      return (
                        <button key={opt} onClick={() => update(cat.key, opt)}
                          className={`w-14 h-14 rounded-full transition-transform ${active ? 'scale-110 ring-4 ring-blue-500 ring-offset-4 ring-offset-gray-800' : 'hover:scale-105'}`}
                          style={{ backgroundColor: opt }} title={opt} />
                      );
                    }
                    return (
                      <button key={opt} onClick={() => update(cat.key, opt)}
                        className={`px-5 py-3 rounded-xl text-sm font-medium transition-colors border ${active ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600 hover:text-white'}`}>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MULTI QUIZ HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const hostPeerId = (code: string) => `cpea-${code.toLowerCase()}`;
const makeCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MULTI QUIZ HUB (now cross-device via PeerJS)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function MultiQuizHub({ user, blynk, onBack, onJoinLobby }: {
  user: User; blynk: BlynkStyle; onBack: () => void; onJoinLobby: (session: MPSession, room: MPRoom | null) => void;
}) {
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [code, setCode] = useState('');
  const [selectedSubject, setSelectedSubject] = useState<Subject>('math');

  const handleCreate = () => {
    const code = makeCode();
    const myId = hostPeerId(code);
    const session: MPSession = { role: 'host', roomCode: code, myPeerId: myId };
    const room: MPRoom = {
      code,
      creator: user.name,
      players: [{ id: myId, name: user.name, blynk, score: 0, answers: {} }],
      subject: selectedSubject,
      questions: getQuestions(selectedSubject),
      status: 'waiting',
      currentQ: 0,
      questionStartTime: 0,
      timePerQuestion: 15,
      teacherMode: false,
      showLeaderboard: false,
    };
    onJoinLobby(session, room);
  };

  const handleJoin = () => {
    const clean = code.trim().toUpperCase();
    if (clean.length < 4) return;
    const session: MPSession = { role: 'guest', roomCode: clean, myPeerId: `g-${Math.random().toString(36).slice(2, 9)}` };
    onJoinLobby(session, null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-pink-50 via-white to-rose-50">
      <div className="bg-gradient-to-r from-pink-500 to-rose-500 text-white">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <button onClick={onBack} className="text-sm text-pink-200 hover:text-white mb-3">← back home</button>
          <h1 className="text-2xl md:text-3xl font-extrabold">🎮 Multiplayer Quiz</h1>
          <p className="text-pink-200 text-sm mt-1">Now works across devices. Host must stay online.</p>
        </div>
      </div>
      <div className="max-w-lg mx-auto px-4 py-8">
        <div className="flex bg-gray-100 rounded-xl p-1 mb-6">
          <button onClick={() => setTab('create')} className={`flex-1 py-3 rounded-lg font-bold text-sm transition-all ${tab === 'create' ? 'bg-white shadow-md text-pink-600' : 'text-gray-500'}`}>🎨 Create</button>
          <button onClick={() => setTab('join')} className={`flex-1 py-3 rounded-lg font-bold text-sm transition-all ${tab === 'join' ? 'bg-white shadow-md text-pink-600' : 'text-gray-500'}`}>🔗 Join</button>
        </div>
        {tab === 'create' ? (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 space-y-4">
            <h3 className="font-bold text-gray-800 text-lg">Create a New Quiz</h3>
            <div className="grid grid-cols-2 gap-2">
              {(['math', 'language', 'science', 'social'] as Subject[]).map(s => (
                <button key={s} onClick={() => setSelectedSubject(s)} className={`p-3 rounded-xl text-sm font-medium border-2 transition-all ${selectedSubject === s ? 'border-pink-500 bg-pink-50 text-pink-700' : 'border-gray-200 text-gray-600 hover:border-pink-300'}`}>{subjectInfo[s].emoji} {subjectInfo[s].name}</button>
              ))}
            </div>
            <button onClick={handleCreate} className="w-full bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-xl px-6 py-4 shadow-lg">🚀 Create Quiz Room</button>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 space-y-4">
            <h3 className="font-bold text-gray-800 text-lg">Join a Quiz</h3>
            <input type="text" value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. XK4M9P" className="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-center text-xl font-bold tracking-widest uppercase focus:border-pink-400 outline-none" maxLength={8} />
            <button onClick={handleJoin} className="w-full bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-xl px-6 py-4 shadow-lg">🎮 Join Quiz</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MULTI QUIZ LOBBY (PeerJS real-time)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function MultiQuizLobby({ session, initialRoom, user, blynk, onRoomUpdate, onBack, onStartGame }: {
  session: MPSession; initialRoom: MPRoom | null; user: User; blynk: BlynkStyle;
  onRoomUpdate: (r: MPRoom | null) => void; onBack: () => void; onStartGame: () => void;
}) {
  const [room, setRoom] = useState<MPRoom | null>(initialRoom);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const peerRef = useRef<Peer | null>(null);
  const hostConnRef = useRef<DataConnection | null>(null);
  const connsRef = useRef<Map<string, DataConnection>>(new Map());

  const isHost = session.role === 'host';

  const pushRoom = (next: MPRoom) => {
    setRoom(next);
    onRoomUpdate(next);
    if (isHost) {
      connsRef.current.forEach(c => c.open && c.send({ type: 'room_state', room: next } as MPMessage));
    }
  };

  const handleHostData = (conn: DataConnection, msg: MPMessage) => {
    if (!room) return;
    if (msg.type === 'join') {
      if (!room.players.find(p => p.id === msg.peerId)) {
        const next = { ...room, players: [...room.players, { id: msg.peerId, name: msg.name, blynk: msg.blynk, score: 0, answers: {} }] };
        pushRoom(next);
      } else {
        conn.send({ type: 'room_state', room } as MPMessage);
      }
    }
    if (msg.type === 'leave') {
      const next = { ...room, players: room.players.filter(p => p.id !== msg.peerId) };
      pushRoom(next);
    }
  };

  useEffect(() => {
    let disposed = false;
    const peer = new Peer(session.myPeerId);
    peerRef.current = peer;

    peer.on('open', () => {
      if (disposed) return;
      setConnected(true);

      if (isHost) {
        if (initialRoom) pushRoom(initialRoom);
      } else {
        const conn = peer.connect(hostPeerId(session.roomCode));
        hostConnRef.current = conn;
        conn.on('open', () => {
          conn.send({ type: 'join', name: user.name, blynk, peerId: session.myPeerId } as MPMessage);
        });
        conn.on('data', (raw: unknown) => {
          const msg = raw as MPMessage;
          if (msg.type === 'room_state') {
            setRoom(msg.room);
            onRoomUpdate(msg.room);
            if (msg.room.status === 'playing') onStartGame();
          }
        });
        conn.on('error', () => setError('Could not connect to host. Check code and ask host to keep lobby open.'));
      }
    });

    peer.on('connection', (conn) => {
      if (!isHost) return;
      connsRef.current.set(conn.peer, conn);
      conn.on('data', (raw: unknown) => handleHostData(conn, raw as MPMessage));
      conn.on('close', () => {
        connsRef.current.delete(conn.peer);
        if (room) pushRoom({ ...room, players: room.players.filter(p => p.id !== conn.peer) });
      });
      if (room) conn.send({ type: 'room_state', room } as MPMessage);
    });

    peer.on('error', () => setError('Network issue while creating/joining room.'));

    return () => {
      disposed = true;
      if (!isHost && hostConnRef.current?.open) {
        hostConnRef.current.send({ type: 'leave', peerId: session.myPeerId } as MPMessage);
      }
      connsRef.current.forEach(c => c.close());
      peer.destroy();
    };
  }, []);

  const startGame = () => {
    if (!room || room.players.length < 2 || !isHost) return;
    const next: MPRoom = { ...room, status: 'playing', currentQ: 0, questionStartTime: Date.now() };
    pushRoom(next);
    onStartGame();
  };

  const leave = () => {
    if (!isHost && hostConnRef.current?.open) {
      hostConnRef.current.send({ type: 'leave', peerId: session.myPeerId } as MPMessage);
    }
    onBack();
  };

  const playerCount = room?.players.length ?? 0;
  const canStart = !!room && playerCount >= 2;
  const neededMore = Math.max(0, 2 - playerCount);

  return (
    <div className="min-h-screen bg-gradient-to-b from-pink-50 via-white to-rose-50">
      <div className="bg-gradient-to-r from-pink-500 to-rose-500 text-white">
        <div className="max-w-4xl mx-auto px-4 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-extrabold">Quiz Lobby 🎮</h1>
            <p className="text-pink-200 text-sm">Code: <span className="font-bold text-white text-lg tracking-widest">{session.roomCode}</span> {connected ? '• online' : '• connecting...'}</p>
          </div>
          <button onClick={leave} className="text-sm bg-white/20 hover:bg-white/30 px-4 py-2 rounded-lg">Leave</button>
        </div>
      </div>
      <div className="max-w-2xl mx-auto px-4 py-8">
        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 mb-4 text-sm">{error}</div>}
        {!room ? (
          <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 text-center text-gray-500">Waiting for room state from host...</div>
        ) : (
          <>
            <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 mb-6">
              <div className="flex items-center justify-between mb-4"><h3 className="font-bold text-gray-800 text-lg">Players ({room.players.length})</h3><span className="text-sm text-gray-500">{subjectInfo[room.subject].emoji} {subjectInfo[room.subject].name}</span></div>
              <div className="space-y-3">
                {room.players.map(p => (
                  <div key={p.id} className="flex items-center gap-3 bg-gray-50 rounded-xl p-4">
                    <MiniBlynk blynk={p.blynk} size={50} />
                    <div><p className="font-bold text-gray-800">{p.name} {p.name === room.creator && <span className="text-xs bg-pink-100 text-pink-600 px-2 py-0.5 rounded-full">Host</span>}</p><p className="text-xs text-gray-500">Score: {p.score}</p></div>
                  </div>
                ))}
              </div>
              {!canStart && <p className="text-amber-600 text-sm mt-4 text-center bg-amber-50 rounded-lg p-3">⚠️ Need at least 2 players to start — the host counts as 1, so you only need {neededMore} more player{neededMore === 1 ? '' : 's'}.</p>}
            </div>

            {/* Host settings panel */}
            {isHost && (
              <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-6 mb-6">
                <h3 className="font-bold text-gray-800 text-lg mb-4 flex items-center gap-2">⚙️ Host Settings</h3>

                {/* Time per question */}
                <div className="mb-5">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Time per Question</label>
                  <div className="flex flex-wrap gap-2">
                    {[10, 15, 20, 30, 45, 60].map(secs => (
                      <button key={secs} onClick={() => pushRoom({ ...room, timePerQuestion: secs })}
                        className={`px-4 py-2 rounded-lg text-sm font-medium border-2 transition-all ${room.timePerQuestion === secs ? 'border-pink-500 bg-pink-50 text-pink-700' : 'border-gray-200 text-gray-600 hover:border-pink-300'}`}>
                        {secs}s
                      </button>
                    ))}
                  </div>
                </div>

                {/* Teacher mode toggle */}
                <div className="mb-2">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={room.teacherMode} onChange={e => pushRoom({ ...room, teacherMode: e.target.checked })}
                      className="mt-1 w-5 h-5 rounded border-2 border-gray-300 text-pink-500 focus:ring-pink-400" />
                    <div>
                      <p className="font-medium text-gray-800">👩‍🏫 Teacher Mode</p>
                      <p className="text-xs text-gray-500">Get extra controls during the quiz: skip question, end early, view all answers. You still play and count as a participant!</p>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {isHost ? (
              <button onClick={startGame} disabled={!canStart} className={`w-full font-bold rounded-xl px-6 py-4 shadow-lg ${canStart ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>{canStart ? '🚀 Start Quiz!' : `Waiting for ${neededMore} more player${neededMore === 1 ? '' : 's'}... (host counts)`}</button>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 text-center text-sm text-gray-500">
                <p>Waiting for host to start...</p>
                <p className="text-xs mt-2 text-gray-400">⏱ {room.timePerQuestion}s per question{room.teacherMode ? ' • Teacher Mode on' : ''}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MULTI QUIZ GAME (host authoritative)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function MultiQuizGame({ session, initialRoom, user, onRoomUpdate, onBack }: {
  session: MPSession; initialRoom: MPRoom; user: User; onRoomUpdate: (r: MPRoom | null) => void; onBack: () => void;
}) {
  const [room, setRoom] = useState<MPRoom>(initialRoom);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [answered, setAnswered] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const peerRef = useRef<Peer | null>(null);
  const hostConnRef = useRef<DataConnection | null>(null);
  const connsRef = useRef<Map<string, DataConnection>>(new Map());
  const isHost = session.role === 'host';

  const pushRoom = (next: MPRoom) => {
    setRoom(next);
    onRoomUpdate(next);
    if (isHost) connsRef.current.forEach(c => c.open && c.send({ type: 'room_state', room: next } as MPMessage));
  };

  const currentQ = room.questions[room.currentQ];
  const elapsed = Math.floor((now - room.questionStartTime) / 1000);
  const timeLimit = room.timePerQuestion || 15;
  const timePerQ = Math.max(0, timeLimit - elapsed);
  const reveal = timePerQ === 0;
  const totalQs = room.questions.length;
  const isLeaderboardCheckpoint = (room.currentQ + 1) % 10 === 0 && room.currentQ + 1 < totalQs;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const peer = new Peer(session.myPeerId);
    peerRef.current = peer;

    peer.on('open', () => {
      if (!isHost) {
        const conn = peer.connect(hostPeerId(session.roomCode));
        hostConnRef.current = conn;
        conn.on('open', () => conn.send({ type: 'join', name: user.name, blynk: room.players.find(p => p.name === user.name)?.blynk || DEFAULT_BLYNK, peerId: session.myPeerId } as MPMessage));
        conn.on('data', (raw: unknown) => {
          const msg = raw as MPMessage;
          if (msg.type === 'room_state') {
            setRoom(msg.room);
            onRoomUpdate(msg.room);
          }
        });
        conn.on('error', () => setError('Lost connection to host.'));
      }
    });

    if (isHost) {
      peer.on('connection', (conn) => {
        connsRef.current.set(conn.peer, conn);
        conn.on('data', (raw: unknown) => {
          const msg = raw as MPMessage;
          if (msg.type === 'submit_answer') {
            setRoom(prev => {
              const playerIdx = prev.players.findIndex(p => p.id === msg.peerId);
              if (playerIdx < 0) return prev;
              if (prev.players[playerIdx].answers[prev.currentQ] !== undefined) return prev;
              const next = { ...prev, players: [...prev.players] };
              next.players[playerIdx] = { ...next.players[playerIdx], answers: { ...next.players[playerIdx].answers, [prev.currentQ]: msg.answer } };
              if (msg.answer === prev.questions[prev.currentQ].correct) next.players[playerIdx].score += 1;
              onRoomUpdate(next);
              connsRef.current.forEach(c => c.open && c.send({ type: 'room_state', room: next } as MPMessage));
              return next;
            });
          }
          if (msg.type === 'leave') {
            setRoom(prev => {
              const next = { ...prev, players: prev.players.filter(p => p.id !== msg.peerId) };
              onRoomUpdate(next);
              connsRef.current.forEach(c => c.open && c.send({ type: 'room_state', room: next } as MPMessage));
              return next;
            });
          }
        });
        conn.send({ type: 'room_state', room } as MPMessage);
      });
    }

    return () => {
      if (!isHost && hostConnRef.current?.open) hostConnRef.current.send({ type: 'leave', peerId: session.myPeerId } as MPMessage);
      connsRef.current.forEach(c => c.close());
      peer.destroy();
    };
  }, []);

  const submitAnswer = (answer: number) => {
    if (answered || reveal || room.status !== 'playing') return;
    setAnswered(true);
    setSelectedAnswer(answer);
    if (isHost) {
      const msg: MPMessage = { type: 'submit_answer', peerId: session.myPeerId, answer };
      // Reuse same path as remote submit
      setRoom(prev => {
        const playerIdx = prev.players.findIndex(p => p.id === msg.peerId);
        if (playerIdx < 0 || prev.players[playerIdx].answers[prev.currentQ] !== undefined) return prev;
        const next = { ...prev, players: [...prev.players] };
        next.players[playerIdx] = { ...next.players[playerIdx], answers: { ...next.players[playerIdx].answers, [prev.currentQ]: answer } };
        if (answer === prev.questions[prev.currentQ].correct) next.players[playerIdx].score += 1;
        onRoomUpdate(next);
        connsRef.current.forEach(c => c.open && c.send({ type: 'room_state', room: next } as MPMessage));
        return next;
      });
    } else {
      hostConnRef.current?.send({ type: 'submit_answer', peerId: session.myPeerId, answer } as MPMessage);
    }
  };

  const nextQuestion = () => {
    if (!isHost) return;
    // If we're at a leaderboard checkpoint and not currently showing it, show it first
    if (isLeaderboardCheckpoint && !room.showLeaderboard) {
      pushRoom({ ...room, showLeaderboard: true });
      return;
    }
    if (room.currentQ >= room.questions.length - 1) {
      const next = { ...room, status: 'finished' as const, showLeaderboard: false };
      pushRoom(next);
      return;
    }
    const next = { ...room, currentQ: room.currentQ + 1, questionStartTime: Date.now(), showLeaderboard: false };
    setSelectedAnswer(null);
    setAnswered(false);
    pushRoom(next);
  };

  const skipQuestion = () => {
    if (!isHost) return;
    // Force timer to expire so reveal shows immediately
    pushRoom({ ...room, questionStartTime: Date.now() - timeLimit * 1000 });
  };

  const endQuizEarly = () => {
    if (!isHost) return;
    pushRoom({ ...room, status: 'finished', showLeaderboard: false });
  };

  useEffect(() => {
    setSelectedAnswer(null);
    setAnswered(false);
  }, [room.currentQ]);

  // Mid-quiz leaderboard screen (every 10 questions)
  if (room.showLeaderboard && room.status === 'playing') {
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    const top3 = sorted.slice(0, 3);
    const bottom = sorted.slice(3, 6); // ranks 4-6
    const emptyTopSlots = 3 - top3.length;
    const emptyBottomSlots = 3 - bottom.length;
    const medals = ['🥇', '🥈', '🥉'];
    return (
      <div className="min-h-screen bg-gradient-to-b from-pink-50 via-white to-rose-50">
        <div className="bg-gradient-to-r from-pink-500 to-rose-500 text-white">
          <div className="max-w-4xl mx-auto px-4 py-6 text-center">
            <h1 className="text-2xl md:text-3xl font-extrabold">📊 Leaderboard Checkpoint</h1>
            <p className="text-pink-200 text-sm mt-1">After Question {room.currentQ + 1} of {totalQs}</p>
          </div>
        </div>
        <div className="max-w-2xl mx-auto px-4 py-8">
          {/* Top 3 */}
          <h2 className="font-bold text-gray-800 text-lg mb-3">🏆 Top 3</h2>
          <div className="space-y-3 mb-8">
            {top3.map((p, i) => (
              <div key={p.id} className={`bg-white rounded-2xl shadow-md border p-5 flex items-center gap-4 ${i === 0 ? 'border-yellow-400 ring-2 ring-yellow-300' : 'border-gray-100'}`}>
                <div className="text-3xl font-extrabold w-12 text-center">{medals[i]}</div>
                <MiniBlynk blynk={p.blynk} size={50} />
                <div className="flex-1"><p className="font-bold text-gray-800">{p.name}{p.name === room.creator && <span className="ml-2 text-xs bg-pink-100 text-pink-600 px-2 py-0.5 rounded-full">Host</span>}</p><p className="text-sm text-gray-500">{p.score} / {room.currentQ + 1} correct</p></div>
                <div className="text-2xl font-extrabold text-pink-600">{Math.round((p.score / (room.currentQ + 1)) * 100)}%</div>
              </div>
            ))}
            {Array.from({ length: emptyTopSlots }).map((_, i) => (
              <div key={`et${i}`} className="bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 p-5 flex items-center gap-4 text-gray-400">
                <div className="text-3xl font-extrabold w-12 text-center opacity-40">{medals[top3.length + i]}</div>
                <div className="w-12 h-12 rounded-full bg-gray-200" />
                <div className="flex-1 italic text-sm">empty</div>
              </div>
            ))}
          </div>

          {/* Ranks 4-6 */}
          <h2 className="font-bold text-gray-800 text-lg mb-3">🎯 Ranks 4 – 6</h2>
          <div className="space-y-3 mb-8">
            {bottom.map((p, i) => (
              <div key={p.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center gap-4">
                <div className="text-xl font-bold w-10 text-center text-gray-500">#{i + 4}</div>
                <MiniBlynk blynk={p.blynk} size={40} />
                <div className="flex-1"><p className="font-bold text-gray-800">{p.name}</p><p className="text-xs text-gray-500">{p.score} / {room.currentQ + 1} correct</p></div>
                <div className="text-lg font-bold text-pink-600">{Math.round((p.score / (room.currentQ + 1)) * 100)}%</div>
              </div>
            ))}
            {Array.from({ length: emptyBottomSlots }).map((_, i) => (
              <div key={`eb${i}`} className="bg-gray-50 rounded-xl border-2 border-dashed border-gray-200 p-4 flex items-center gap-4 text-gray-400">
                <div className="text-xl font-bold w-10 text-center opacity-40">#{4 + bottom.length + i}</div>
                <div className="w-10 h-10 rounded-full bg-gray-200" />
                <div className="flex-1 italic text-sm">empty</div>
              </div>
            ))}
          </div>

          {isHost ? (
            <button onClick={nextQuestion} className="w-full bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-xl px-6 py-4 shadow-lg">Continue Quiz →</button>
          ) : (
            <p className="text-center text-gray-500">Waiting for host to continue...</p>
          )}
        </div>
      </div>
    );
  }

  if (room.status === 'finished') {
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    return (
      <div className="min-h-screen bg-gradient-to-b from-pink-50 via-white to-rose-50">
        <div className="bg-gradient-to-r from-pink-500 to-rose-500 text-white"><div className="max-w-4xl mx-auto px-4 py-8 text-center"><h1 className="text-3xl font-extrabold">🏆 Quiz Over!</h1><p className="text-pink-200 text-sm">Final Results</p></div></div>
        <div className="max-w-2xl mx-auto px-4 py-8 space-y-3">
          {sorted.map((p, i) => (
            <div key={p.id} className={`bg-white rounded-2xl shadow-md border p-5 flex items-center gap-4 ${i === 0 ? 'border-yellow-400 ring-2 ring-yellow-300' : 'border-gray-100'}`}>
              <div className="text-3xl font-extrabold w-12 text-center">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</div>
              <MiniBlynk blynk={p.blynk} size={50} />
              <div className="flex-1"><p className="font-bold text-gray-800">{p.name}</p><p className="text-sm text-gray-500">{p.score}/{room.questions.length}</p></div>
              <div className="text-2xl font-extrabold text-pink-600">{Math.round((p.score / room.questions.length) * 100)}%</div>
            </div>
          ))}
          <button onClick={onBack} className="w-full bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-xl px-6 py-4 shadow-lg">🏠 Back to Home</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-pink-50 via-white to-rose-50">
      <div className="bg-white border-b border-gray-200 sticky top-0 z-30 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <span className="font-bold text-gray-800">{subjectInfo[room.subject].emoji} Q{room.currentQ + 1}/{room.questions.length}</span>
          <div className={`text-lg font-mono font-bold ${timePerQ <= 5 ? 'text-red-600 animate-pulse' : 'text-pink-600'}`}>{timePerQ}s</div>
          <div className="flex items-center gap-3">{room.players.map(p => (<div key={p.id} className="flex items-center gap-1 text-xs"><MiniBlynk blynk={p.blynk} size={24} /><span className="font-bold">{p.score}</span></div>))}</div>
        </div>
        <div className="max-w-4xl mx-auto px-4 pb-2"><div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${timePerQ <= 5 ? 'bg-red-500' : 'bg-pink-500'}`} style={{ width: `${(timePerQ / timeLimit) * 100}%` }}></div></div></div>
      </div>
      <div className="max-w-2xl mx-auto px-4 py-8">
        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 mb-4 text-sm">{error}</div>}

        {/* Teacher mode control bar */}
        {isHost && room.teacherMode && (
          <div className="bg-purple-50 border border-purple-200 rounded-2xl p-4 mb-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-bold text-purple-700 flex items-center gap-1">👩‍🏫 Teacher Controls</span>
              <span className="text-xs text-purple-600">{room.players.filter(p => p.answers[room.currentQ] !== undefined).length} / {room.players.length} answered</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {!reveal && <button onClick={skipQuestion} className="text-xs bg-white hover:bg-purple-100 border border-purple-300 text-purple-700 font-medium px-3 py-2 rounded-lg">⏭ Skip Question</button>}
              <button onClick={endQuizEarly} className="text-xs bg-white hover:bg-red-50 border border-red-300 text-red-600 font-medium px-3 py-2 rounded-lg">🏁 End Quiz / View Results</button>
              <button onClick={() => pushRoom({ ...room, showLeaderboard: true })} className="text-xs bg-white hover:bg-pink-50 border border-pink-300 text-pink-600 font-medium px-3 py-2 rounded-lg">📊 Show Leaderboard</button>
            </div>
            {/* Live answer view */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              {room.players.map(p => {
                const ans = p.answers[room.currentQ];
                const answered = ans !== undefined;
                const correct = answered && ans === currentQ.correct;
                return (
                  <div key={p.id} className={`text-xs flex items-center gap-2 px-2 py-1 rounded-lg ${!answered ? 'bg-gray-100 text-gray-500' : correct ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    <span className="font-medium truncate flex-1">{p.name}</span>
                    <span>{!answered ? '...' : correct ? '✓' : '✗'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
          <div className="p-6">
            <p className="text-lg text-gray-800 font-medium mb-6">{currentQ.question}</p>
            {currentQ.image && <div className="mb-6 flex justify-center"><img src={currentQ.image} alt="" className="max-w-xs max-h-40 rounded-xl shadow-md border" /></div>}
            <div className="space-y-3">
              {currentQ.options.map((opt, i) => {
                const myAns = room.players.find(p => p.id === session.myPeerId)?.answers[room.currentQ];
                let cls = 'border-gray-200 hover:border-pink-300';
                if (reveal) {
                  if (i === currentQ.correct) cls = 'border-green-500 bg-green-50 shadow-md';
                  else if (i === myAns) cls = 'border-red-500 bg-red-50';
                  else cls = 'border-gray-200 opacity-50';
                } else if (selectedAnswer === i) cls = 'border-pink-500 bg-pink-50 shadow-md';
                return (
                  <button key={i} onClick={() => submitAnswer(i)} disabled={reveal || answered}
                    className={`w-full text-left flex items-center gap-4 px-5 py-4 rounded-xl border-2 transition-all ${cls}`}>
                    <span className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${reveal && i === currentQ.correct ? 'bg-green-500 text-white' : selectedAnswer === i && !reveal ? 'bg-pink-500 text-white' : 'bg-gray-100 text-gray-600'}`}>{['A','B','C'][i]}</span>
                    <span className="font-medium text-gray-700">{opt}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {reveal && (
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
              <p className="text-sm text-gray-600 mb-3">{currentQ.explanation}</p>
              {isHost ? (
                <button onClick={nextQuestion} className="w-full bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-xl px-6 py-3 shadow-md">{room.currentQ < room.questions.length - 1 ? 'Next →' : 'See Results 🏆'}</button>
              ) : (
                <p className="text-center text-sm text-gray-500">Waiting for host to continue...</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
