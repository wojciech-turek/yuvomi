/**
 * Modul: Polish grocery starter list (fork, 2026-10-19)
 * Zweck: Autocomplete before the household has a history: common Polish
 *        shopping-list names with their aisle (shopping_categories default
 *        names). Ranked below anything the household itself bought or listed,
 *        so it fades out as Yuvomi learns the household's own words.
 */

const LIST = {
  'Obst & Gemüse': [
    'Jabłka', 'Banany', 'Pomarańcze', 'Mandarynki', 'Cytryny', 'Limonki', 'Gruszki', 'Winogrona', 'Truskawki',
    'Maliny', 'Borówki', 'Kiwi', 'Ananas', 'Mango', 'Awokado', 'Arbuz', 'Śliwki', 'Brzoskwinie', 'Nektarynki',
    'Pomidory', 'Pomidorki koktajlowe', 'Ogórki', 'Ogórki kiszone', 'Papryka czerwona', 'Papryka żółta',
    'Sałata', 'Rukola', 'Szpinak', 'Kapusta', 'Kapusta pekińska', 'Kalafior', 'Brokuł', 'Marchew', 'Pietruszka',
    'Seler', 'Por', 'Cebula', 'Cebula czerwona', 'Czosnek', 'Ziemniaki', 'Bataty', 'Buraki', 'Cukinia', 'Bakłażan',
    'Dynia', 'Pieczarki', 'Rzodkiewka', 'Koperek', 'Natka pietruszki', 'Szczypiorek', 'Bazylia', 'Imbir',
    'Fasolka szparagowa', 'Kukurydza', 'Młode ziemniaki',
  ],
  'Backwaren': [
    'Chleb', 'Chleb razowy', 'Chleb żytni', 'Bułki', 'Bułki grahamki', 'Kajzerki', 'Bagietka', 'Rogaliki',
    'Chałka', 'Tortille', 'Mąka pszenna', 'Mąka żytnia', 'Drożdże', 'Proszek do pieczenia', 'Makaron spaghetti',
    'Makaron penne', 'Makaron świderki', 'Makaron do rosołu', 'Lasagne', 'Płatki owsiane', 'Płatki kukurydziane',
    'Musli', 'Bułka tarta',
  ],
  'Milchprodukte': [
    'Mleko', 'Mleko 2%', 'Mleko 3,2%', 'Masło', 'Śmietana 18%', 'Śmietana 30%', 'Śmietanka do kawy',
    'Jogurt naturalny', 'Jogurt grecki', 'Kefir', 'Maślanka', 'Twaróg', 'Serek wiejski', 'Serek homogenizowany',
    'Ser żółty', 'Ser gouda', 'Mozzarella', 'Parmezan', 'Feta', 'Ser pleśniowy', 'Jajka', 'Margaryna', 'Skyr',
    'Mascarpone',
  ],
  'Fleisch & Fisch': [
    'Pierś z kurczaka', 'Udka z kurczaka', 'Skrzydełka z kurczaka', 'Mięso mielone', 'Mięso mielone wołowe',
    'Schab', 'Karkówka', 'Łopatka wieprzowa', 'Boczek', 'Wołowina', 'Indyk', 'Szynka', 'Polędwica', 'Kiełbasa',
    'Parówki', 'Salami', 'Kabanosy', 'Pasztet', 'Łosoś', 'Dorsz', 'Tuńczyk w puszce', 'Śledzie', 'Makrela wędzona',
    'Krewetki',
  ],
  'Tiefkühl': [
    'Mrożone warzywa', 'Mrożony szpinak', 'Mrożone owoce', 'Frytki', 'Pierogi', 'Pizza mrożona', 'Lody',
    'Mrożona ryba', 'Mieszanka chińska',
  ],
  'Getränke': [
    'Woda', 'Woda gazowana', 'Sok pomarańczowy', 'Sok jabłkowy', 'Kawa', 'Kawa ziarnista', 'Herbata',
    'Herbata zielona', 'Piwo', 'Wino', 'Cola', 'Napój roślinny', 'Kompot',
  ],
  'Haushalt': [
    'Papier toaletowy', 'Ręczniki papierowe', 'Chusteczki higieniczne', 'Worki na śmieci', 'Płyn do naczyń',
    'Tabletki do zmywarki', 'Sól do zmywarki', 'Proszek do prania', 'Kapsułki do prania', 'Płyn do płukania',
    'Gąbki', 'Folia aluminiowa', 'Folia spożywcza', 'Papier do pieczenia', 'Serwetki', 'Płyn do mycia podłóg',
    'Domestos', 'Odświeżacz powietrza', 'Baterie', 'Żarówki',
  ],
  'Drogerie': [
    'Pasta do zębów', 'Szczoteczka do zębów', 'Szampon', 'Odżywka do włosów', 'Żel pod prysznic', 'Mydło',
    'Dezodorant', 'Krem do rąk', 'Balsam do ciała', 'Płatki kosmetyczne', 'Patyczki higieniczne',
    'Nici dentystyczne', 'Płyn do płukania ust', 'Maszynki do golenia', 'Pianka do golenia', 'Podpaski', 'Tampony',
    'Pieluchy', 'Chusteczki nawilżane',
  ],
  'Sonstiges': [
    'Cukier', 'Sól', 'Pieprz', 'Olej', 'Oliwa z oliwek', 'Ocet', 'Ryż', 'Kasza gryczana', 'Kasza jaglana',
    'Kasza kuskus', 'Fasola w puszce', 'Ciecierzyca', 'Soczewica', 'Pomidory w puszce', 'Passata pomidorowa',
    'Koncentrat pomidorowy', 'Kukurydza w puszce', 'Groszek w puszce', 'Ketchup', 'Majonez', 'Musztarda',
    'Chrzan', 'Sos sojowy', 'Bulion', 'Miód', 'Dżem', 'Nutella', 'Masło orzechowe', 'Czekolada', 'Ciastka',
    'Chipsy', 'Orzechy', 'Rodzynki', 'Kakao', 'Cukier puder', 'Cukier wanilinowy', 'Papryka słodka', 'Oregano',
    'Majeranek', 'Liść laurowy', 'Ziele angielskie', 'Cynamon', 'Kurkuma', 'Przyprawa do kurczaka',
    'Karma dla kota', 'Karma dla psa',
  ],
};

/** [{ name, category }] */
export const PL_GROCERIES = Object.freeze(
  Object.entries(LIST).flatMap(([category, names]) => names.map((name) => Object.freeze({ name, category }))),
);
