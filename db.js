const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// --- Configuration for Database Path ---
const isProduction = process.env.NODE_ENV === 'production';

let dbDirectory;
if (isProduction) {
    const persistentDiskMountPath = process.env.RENDER_DISK_MOUNT_PATH || '/data';
    dbDirectory = path.join(persistentDiskMountPath, 'database_files');
    console.log(`[DB_INFO] PRODUCTION mode: Using persistent disk path for database: ${dbDirectory}`);
} else {
    dbDirectory = path.join(__dirname, 'local_sqlite_db');
    console.log(`[DB_INFO] DEVELOPMENT mode: Using local path for database: ${dbDirectory}`);
}

if (!fs.existsSync(dbDirectory)) {
    try {
        fs.mkdirSync(dbDirectory, { recursive: true });
        console.log(`[DB_INFO] Successfully created database directory: ${dbDirectory}`);
    } catch (e) {
        console.error(`[DB_CRITICAL_ERROR] Could not create database directory at ${dbDirectory}:`, e.message);
        throw e;
    }
} else {
    console.log(`[DB_INFO] Database directory already exists: ${dbDirectory}`);
}

const DBSOURCE = path.join(dbDirectory, "steamdle.sqlite");
// --- End Configuration for Database Path ---

console.log(`[DB_INFO] Attempting to connect to/create SQLite database at: ${DBSOURCE}`);
let db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
        console.error("[DB_ERROR] Could not connect to/create database file. Error:", err.message);
    } else {
        console.log("[DB_INFO] Successfully opened/created SQLite database file at:", DBSOURCE);
    }
    initializeDatabaseStructure();
});

function initializeDatabaseStructure() {
    console.log("[DB_INFO] Initializing database structure (tables 'games' and 'game_reviews')...");
    db.serialize(() => { // Use serialize to ensure table creation finishes before seeding check
        db.exec(`
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL UNIQUE,
                steam_app_id TEXT NOT NULL,
                last_played_on DATE,
                is_active BOOLEAN DEFAULT TRUE
            );

            CREATE TABLE IF NOT EXISTS game_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                review_page_url TEXT NOT NULL UNIQUE,
                clue_order INTEGER NOT NULL,
                FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
            );
        `, (err) => {
            if (err) {
                console.error("[DB_ERROR] Error during table creation (games, game_reviews):", err.message);
            } else {
                console.log("[DB_INFO] Tables 'games' and 'game_reviews' integrity check/creation successful.");
                // Call checkAndSeedDatabase AFTER tables are confirmed to exist
                checkAndSeedDatabase();
            }
        });
    });
}

function checkAndSeedDatabase() {
    // This function will now always call seedInitialData.
    // The upsert logic within seedInitialData handles existing/new data.
    // An optional environment variable could be used to disable seeding if ever needed.
    if (process.env.DISABLE_DB_SEED === 'true') {
        console.log("[DB_INFO] Database seeding is disabled via DISABLE_DB_SEED environment variable.");
        return;
    }
    console.log("[DB_INFO] Preparing to synchronize database with seed data (upsert mode)...");
    seedInitialData();
}

async function seedInitialData() {
    console.log("[SEED_INFO] --- Starting seedInitialData (Upsert & Cleanup Mode) ---");

    // Define your games here.
    // - 'title': The exact game title players will guess.
    // - 'steam_app_id': The game's ID on Steam (from its store page URL).
    // - 'reviews': An array of 6 strings. Each string MUST be a FULL URL
    //              to an actual Steam review page.
    //              Example: "https://steamcommunity.com/id/someuser/recommended/12345/"
    const gamesToSeed = [
        {
            title: "Portal 2",
            steam_app_id: "620",
            reviews: [
                "https://steamcommunity.com/id/Etra_/recommended/620/",
                "https://steamcommunity.com/profiles/76561198883403386/recommended/400/",
                "https://steamcommunity.com/profiles/76561198401838613/recommended/620/",
                "https://steamcommunity.com/id/possysillyboy/recommended/620/",
                "https://steamcommunity.com/profiles/76561199076991591/recommended/620/",
                "https://steamcommunity.com/id/hangover66st/recommended/620/"
            ]
        },
        {
            title: "Stardew Valley",
            steam_app_id: "413150",
            reviews: [
                "https://steamcommunity.com/id/Kekkykekkekkekky/recommended/413150/",
                "https://steamcommunity.com/id/Focusta_/recommended/413150/",
                "https://steamcommunity.com/id/ItsDommyMommy/recommended/413150/",
                "https://steamcommunity.com/profiles/76561198261179773/recommended/413150/",
                "https://steamcommunity.com/id/nuance/recommended/413150/",
                "https://steamcommunity.com/id/killerzimmer/recommended/413150/"
            ]
        },
        {
            title: "Terraria",
            steam_app_id: "105600",
            reviews: [
                "https://steamcommunity.com/id/sugarfanged/recommended/105600/",
                "https://steamcommunity.com/id/CornetTheory/recommended/105600/",
                "https://steamcommunity.com/profiles/76561199014671970/recommended/105600/",
                "https://steamcommunity.com/profiles/76561199003326280/recommended/105600/",
                "https://steamcommunity.com/id/ClarifiedClara/recommended/105600/",
                "https://steamcommunity.com/profiles/76561199480521925/recommended/105600/"
            ]
        },
        {
            title: "Satisfactory",
            steam_app_id: "526870",
            reviews: [
                "https://steamcommunity.com/profiles/76561198994752998/recommended/526870/",
                "https://steamcommunity.com/id/GalaxyFops/recommended/526870/",
                "https://steamcommunity.com/profiles/76561198119457419/recommended/526870/",
                "https://steamcommunity.com/id/aByZMaI/recommended/526870/",
                "https://steamcommunity.com/profiles/76561198127775791/recommended/526870/",
                "https://steamcommunity.com/id/NeoVexan/recommended/526870/"
            ]
        },
        {
            title: "Apex Legends",
            steam_app_id: "1172470",
            reviews: [
                "https://steamcommunity.com/id/Impades/recommended/1172470/",
                "https://steamcommunity.com/id/jacobmuno/recommended/1172470/",
                "https://steamcommunity.com/profiles/76561198258941202/recommended/1172470/",
                "https://steamcommunity.com/id/IWasAbadGirl/recommended/1172470/",
                "https://steamcommunity.com/id/kenyylol/recommended/1172470/",
                "https://steamcommunity.com/id/5tock/recommended/1172470/"
            ]
        },
        {
            title: "Elden Ring",
            steam_app_id: "1245620",
            reviews: [
                "https://steamcommunity.com/profiles/76561198038703897/recommended/1245620/",
                "https://steamcommunity.com/id/RtKitty/recommended/1245620/",
                "https://steamcommunity.com/id/TheRealDripMonkey/recommended/1245620/",
                "https://steamcommunity.com/id/76561198004031162/recommended/1245620/",
                "https://steamcommunity.com/id/haisyub/recommended/1245620/",
                "https://steamcommunity.com/id/dyrwk/recommended/1245620/"
            ]
        },
        {
            title: "R.E.P.O",
            steam_app_id: "3241660",
            reviews: [
                "https://steamcommunity.com/id/sathiriya/recommended/3241660/",
                "https://steamcommunity.com/id/-orpheus/recommended/3241660/",
                "https://steamcommunity.com/id/ehuxley/recommended/3241660/",
                "https://steamcommunity.com/id/bestboi_/recommended/3241660/",
                "https://steamcommunity.com/id/FuzzyIsAlive/recommended/3241660/",
                "https://steamcommunity.com/id/kaitlyngibson/recommended/3241660/"
            ]
        },
        {
            title: "Resident Evil 4",
            steam_app_id: "2050650",
            reviews: [
                "https://steamcommunity.com/id/czechem/recommended/2050650/",
                "https://steamcommunity.com/id/left4shred/recommended/2050650/",
                "https://steamcommunity.com/id/Avargrist/recommended/2050650/",
                "https://steamcommunity.com/profiles/76561198374265199/recommended/2050650/",
                "https://steamcommunity.com/profiles/76561198100249649/recommended/2050650/",
                "https://steamcommunity.com/id/nemesist-type/recommended/2050650/"
            ]
        },
        {
            title: "The Forest",
            steam_app_id: "242760",
            reviews: [
                "https://steamcommunity.com/profiles/76561199091914736/recommended/242760/",
                "https://steamcommunity.com/profiles/76561199125806861/recommended/242760/",
                "https://steamcommunity.com/profiles/76561198208941887/recommended/242760/",
                "https://steamcommunity.com/profiles/76561198078451667/recommended/242760/",
                "https://steamcommunity.com/profiles/76561198310845163/recommended/242760/",
                "https://steamcommunity.com/id/TitanMind/recommended/242760/"
            ]
        },
        {
            title: "Subnautica",
            steam_app_id: "264710",
            reviews: [
                "https://steamcommunity.com/profiles/76561199417250065/recommended/264710/",
                "https://steamcommunity.com/profiles/76561199388576645/recommended/264710/",
                "https://steamcommunity.com/id/TheNopeRoad/recommended/264710/",
                "https://steamcommunity.com/id/951329149/recommended/264710/",
                "https://steamcommunity.com/profiles/76561198403670745/recommended/264710/",
                "https://steamcommunity.com/id/parallacks/recommended/264710/"
            ]
        },
        {
            title: "Halo Infinite",
            steam_app_id: "1240440",
            reviews: [
                "https://steamcommunity.com/id/couragethecat/recommended/1240440/",
                "https://steamcommunity.com/profiles/76561198039328649/recommended/1240440/",
                "https://steamcommunity.com/profiles/76561198808723893/recommended/1240440/",
                "https://steamcommunity.com/id/Delcorexd/recommended/1240440/",
                "https://steamcommunity.com/id/anorak21/recommended/1240440/",
                "https://steamcommunity.com/id/espectrohunk/recommended/1240440/"
            ]
        },
        {
            title: "Borderlands 2",
            steam_app_id: "49520",
            reviews: [
                "https://steamcommunity.com/id/Joequel/recommended/49520/",
                "https://steamcommunity.com/profiles/76561198982170820/recommended/49520/",
                "https://steamcommunity.com/id/POtat0Child/recommended/49520/",
                "https://steamcommunity.com/profiles/76561198283893715/recommended/49520/",
                "https://steamcommunity.com/id/NeeKrox/recommended/49520/",
                "https://steamcommunity.com/id/IS0LAT0R/recommended/49520/"
            ]
        },
        {
            title: "ANIMAL WELL",
            steam_app_id: "813230",
            reviews: [
                "https://steamcommunity.com/profiles/76561198119700865/recommended/813230/",
                "https://steamcommunity.com/id/_SpiderTroll_/recommended/813230/",
                "https://steamcommunity.com/id/OneRockyBoi/recommended/813230/",
                "https://steamcommunity.com/profiles/76561198284853936/recommended/813230/",
                "https://steamcommunity.com/id/Banishmento-dis-waludo/recommended/813230/",
                "https://steamcommunity.com/profiles/76561197978394418/recommended/813230/"
            ]
        },
        {
            title: "Outer Wilds",
            steam_app_id: "753640",
            reviews: [
                "https://steamcommunity.com/profiles/76561198846112985/recommended/753640/",
                "https://steamcommunity.com/profiles/76561198141721312/recommended/753640/",
                "https://steamcommunity.com/profiles/76561198248869468/recommended/753640/",
                "https://steamcommunity.com/profiles/76561198182740454/recommended/753640/",
                "https://steamcommunity.com/id/Zombie1I1/recommended/753640/",
                "https://steamcommunity.com/id/Fludella/recommended/753640/"
            ]
        },
        {
            title: "Storyteller",
            steam_app_id: "1624540",
            reviews: [
                "https://steamcommunity.com/profiles/76561198106113475/recommended/1624540/",
                "https://steamcommunity.com/profiles/76561198851809658/recommended/1624540/",
                "https://steamcommunity.com/id/jemkatkitty/recommended/1624540/",
                "https://steamcommunity.com/id/BluntSam/recommended/1624540/",
                "https://steamcommunity.com/profiles/76561199109946202/recommended/1624540/",
                "https://steamcommunity.com/id/eerflas027/recommended/1624540/"
            ]
        },
        {
            title: "Myst",
            steam_app_id: "1255560",
            reviews: [
                "https://steamcommunity.com/profiles/76561198130408520/recommended/1255560/",
                "https://steamcommunity.com/id/aclfx/recommended/1255560/",
                "https://steamcommunity.com/id/cthulhucrisis/recommended/1255560/",
                "https://steamcommunity.com/id/PogChampion3791/recommended/1255560/",
                "https://steamcommunity.com/profiles/76561198078151458/recommended/1255560/",
                "https://steamcommunity.com/profiles/76561198049183091/recommended/1255560/"
            ]
        },
        {
            title: "Lies of P",
            steam_app_id: "16277720",
            reviews: [
                "https://steamcommunity.com/id/sneezyplays/recommended/1627720/",
                "https://steamcommunity.com/profiles/76561198070110348/recommended/1627720/",
                "https://steamcommunity.com/id/GrannyStation/recommended/1627720/",
                "https://steamcommunity.com/profiles/76561199476656861/recommended/1627720/",
                "https://steamcommunity.com/profiles/76561198393192099/recommended/1627720/",
                "https://steamcommunity.com/profiles/76561198126957161/recommended/1627720/"
            ]
        },
        {
            title: "Hogwarts Legacy",
            steam_app_id: "990080",
            reviews: [
                "https://steamcommunity.com/id/akumikagi/recommended/990080/",
                "https://steamcommunity.com/id/swedishtish/recommended/990080/",
                "https://steamcommunity.com/profiles/76561197969670214/recommended/990080/",
                "https://steamcommunity.com/profiles/76561198290120667/recommended/990080/",
                "https://steamcommunity.com/profiles/76561198142247081/recommended/990080/",
                "https://steamcommunity.com/id/X2Eliah/recommended/990080/"
            ]
        },
        {
            title: "Among Us",
            steam_app_id: "945360",
            reviews: [
                "https://steamcommunity.com/id/brugonometry/recommended/945360/",
                "https://steamcommunity.com/id/omgitspriest/recommended/945360/",
                "https://steamcommunity.com/id/hashu23/recommended/945360/",
                "https://steamcommunity.com/id/fortaime/recommended/945360/",
                "https://steamcommunity.com/profiles/76561198043377725/recommended/945360/",
                "https://steamcommunity.com/id/EarlyZ/recommended/945360/"
            ]
        },
        {
            title: "Gorilla Tag",
            steam_app_id: "1533390",
            reviews: [
                "https://steamcommunity.com/profiles/76561199222814163/recommended/1533390/",
                "https://steamcommunity.com/id/coolguy1260/recommended/1533390/",
                "https://steamcommunity.com/profiles/76561198320644207/recommended/1533390/",
                "https://steamcommunity.com/profiles/76561199612997292/recommended/1533390/",
                "https://steamcommunity.com/id/PlayzerGames/recommended/1533390/",
                "https://steamcommunity.com/id/chineselxsoft/recommended/1533390/"
            ]
        },
        {
            title: "Pizza Tower",
            steam_app_id: "2231450",
            reviews: [
                "https://steamcommunity.com/profiles/76561199527916598/recommended/2231450/",
                "https://steamcommunity.com/id/bursy/recommended/2231450/",
                "https://steamcommunity.com/profiles/76561199601186130/recommended/2231450/",
                "https://steamcommunity.com/id/fiddlestone/recommended/2231450/",
                "https://steamcommunity.com/id/pOllOXD789/recommended/2231450/",
                "https://steamcommunity.com/id/RIPOOB/recommended/2231450/"
            ]
        },
        {
            title: "Half-Life",
            steam_app_id: "70",
            reviews: [
                "https://steamcommunity.com/id/megaapple/recommended/70/",
                "https://steamcommunity.com/profiles/76561198112180826/recommended/70/",
                "https://steamcommunity.com/id/Vatonix/recommended/70/",
                "https://steamcommunity.com/id/janjon98/recommended/70/",
                "https://steamcommunity.com/profiles/76561198359339915/recommended/70/",
                "https://steamcommunity.com/id/megakabuterimon/recommended/70/"
            ]
        },
        {
            title: "Dwarf Fortress",
            steam_app_id: "975370",
            reviews: [
                "https://steamcommunity.com/profiles/76561198039209165/recommended/975370/",
                "https://steamcommunity.com/id/bleepbloopbeert/recommended/975370/",
                "https://steamcommunity.com/profiles/76561199452745082/recommended/975370/",
                "https://steamcommunity.com/profiles/76561198042666928/recommended/975370/",
                "https://steamcommunity.com/profiles/76561198041798902/recommended/975370/",
                "https://steamcommunity.com/profiles/76561198114319682/recommended/975370/"
            ]
        },
        {
            title: "Vampire Survivors",
            steam_app_id: "1794680",
            reviews: [
                "https://steamcommunity.com/profiles/76561198198629187/recommended/1794680/",
                "https://steamcommunity.com/profiles/76561198201928415/recommended/1794680/",
                "https://steamcommunity.com/profiles/76561199596285991/recommended/1794680/",
                "https://steamcommunity.com/id/brigkline/recommended/1794680/",
                "https://steamcommunity.com/id/squallyboo/recommended/1794680/",
                "https://steamcommunity.com/profiles/76561198100249649/recommended/1794680/"
            ]
        },
        {
            title: "Counter-Strike 2",
            steam_app_id: "730",
            reviews: [
                "https://steamcommunity.com/profiles/76561198335590980/recommended/730/",
                "https://steamcommunity.com/profiles/76561198341139450/recommended/730/",
                "https://steamcommunity.com/id/IMANGEL1337/recommended/730/",
                "https://steamcommunity.com/id/zima25/recommended/730/",
                "https://steamcommunity.com/id/lampostjohny19/recommended/730/",
                "https://steamcommunity.com/id/FATEYYYY/recommended/730/"
            ]
        },
        {
            title: "Marvel Rivals",
            steam_app_id: "2767030",
            reviews: [
                "https://steamcommunity.com/id/SilvanusVT/recommended/2767030/",
                "https://steamcommunity.com/profiles/76561198881029636/recommended/2767030/",
                "https://steamcommunity.com/id/Fryrrs/recommended/2767030/",
                "https://steamcommunity.com/id/yubuu/recommended/2767030/",
                "https://steamcommunity.com/id/kelfezond/recommended/2767030/",
                "https://steamcommunity.com/id/Zerathos_Dagon/recommended/2767030/"
            ]
        },
        {
            title: "Balatro",
            steam_app_id: "2379780",
            reviews: [
                "https://steamcommunity.com/profiles/76561198296118902/recommended/2379780/",
                "https://steamcommunity.com/profiles/76561199029912652/recommended/2379780/",
                "https://steamcommunity.com/id/sayteenies/recommended/2379780/",
                "https://steamcommunity.com/id/JuniperTheory2/recommended/2379780/",
                "https://steamcommunity.com/id/mscupcakes/recommended/2379780/",
                "https://steamcommunity.com/profiles/76561198987185457/recommended/2379780/"
            ]
        },
        {
            title: "Path of Exile",
            steam_app_id: "238960",
            reviews: [
                "https://steamcommunity.com/profiles/76561198078333010/recommended/238960/",
                "https://steamcommunity.com/id/yiyuanian/recommended/238960/",
                "https://steamcommunity.com/profiles/76561198076472166/recommended/238960/",
                "https://steamcommunity.com/id/fu-fu-fuu/recommended/238960/",
                "https://steamcommunity.com/id/Kristofer432525/recommended/238960/",
                "https://steamcommunity.com/id/SeaDjinn/recommended/238960/"
            ]
        },
        {
            title: "The Witcher 3: Wild Hunt",
            steam_app_id: "292030",
            reviews: [
                "https://steamcommunity.com/id/iamkio/recommended/292030/",
                "https://steamcommunity.com/profiles/76561199164802263/recommended/292030/",
                "https://steamcommunity.com/profiles/76561199371649476/recommended/292030/",
                "https://steamcommunity.com/id/MilchChocolate/recommended/292030/",
                "https://steamcommunity.com/profiles/76561198038931832/recommended/292030/",
                "https://steamcommunity.com/profiles/76561198801655891/recommended/292030/"
            ]
        },
        {
            title: "Dead by Daylight",
            steam_app_id: "381210",
            reviews: [
                "https://steamcommunity.com/profiles/76561198054225396/recommended/381210/",
                "https://steamcommunity.com/id/thisisnotbritney/recommended/381210/",
                "https://steamcommunity.com/id/raerihel/recommended/381210/",
                "https://steamcommunity.com/id/lifeisfine/recommended/381210/",
                "https://steamcommunity.com/id/AllGunny/recommended/381210/",
                "https://steamcommunity.com/id/JupiterGhoul/recommended/381210/"
            ]
        },
        {
            title: "Lethal Company",
            steam_app_id: "1966720",
            reviews: [
                "https://steamcommunity.com/profiles/76561199202598599/recommended/1966720/",
                "https://steamcommunity.com/profiles/76561199002363268/recommended/1966720/",
                "https://steamcommunity.com/id/djboogyCSGO/recommended/1966720/",
                "https://steamcommunity.com/id/iprobablydontexist/recommended/1966720/",
                "https://steamcommunity.com/profiles/76561199122063117/recommended/1966720/",
                "https://steamcommunity.com/profiles/76561198984489068/recommended/1966720/"
            ]
        },
        {
            title: "Warframe",
            steam_app_id: "230410",
            reviews: [
                "https://steamcommunity.com/id/6266067080/recommended/230410/",
                "https://steamcommunity.com/profiles/76561198086054565/recommended/230410/",
                "https://steamcommunity.com/profiles/76561198159476207/recommended/230410/",
                "https://steamcommunity.com/profiles/76561198799517283/recommended/230410/",
                "https://steamcommunity.com/profiles/76561198044624153/recommended/230410/",
                "https://steamcommunity.com/profiles/76561199041861842/recommended/230410/"
            ]
        },
        {
            title: "Rust",
            steam_app_id: "252490",
            reviews: [
                "https://steamcommunity.com/id/MarsyLia/recommended/252490/",
                "https://steamcommunity.com/profiles/76561198396086694/recommended/252490/",
                "https://steamcommunity.com/id/Sollamel/recommended/252490/",
                "https://steamcommunity.com/id/Realpofu/recommended/252490/",
                "https://steamcommunity.com/id/slymecs/recommended/252490/",
                "https://steamcommunity.com/id/rylanmb/recommended/252490/"
            ]
        },
        {
            title: "Baldur's Gate 3",
            steam_app_id: "1086940",
            reviews: [
                "https://steamcommunity.com/id/Dragonkight2005/recommended/1086940/",
                "https://steamcommunity.com/profiles/76561198968001571/recommended/1086940/",
                "https://steamcommunity.com/profiles/76561198848069470/recommended/1086940/",
                "https://steamcommunity.com/profiles/76561197964430628/recommended/1086940/",
                "https://steamcommunity.com/id/TLLLLLLLLLLL/recommended/1086940/",
                "https://steamcommunity.com/profiles/76561198002549206/recommended/1086940/"
            ]
        },
        {
            title: "HELLDIVERS� 2",
            steam_app_id: "553850",
            reviews: [
                "https://steamcommunity.com/profiles/76561198880429065/recommended/553850/",
                "https://steamcommunity.com/profiles/76561198047483756/recommended/553850/",
                "https://steamcommunity.com/id/DDuckyy/recommended/553850/",
                "https://steamcommunity.com/id/unobtrusivenature/recommended/553850/",
                "https://steamcommunity.com/profiles/76561198069748555/recommended/553850/",
                "https://steamcommunity.com/profiles/76561198281596195/recommended/553850/"
            ]
        },
        {
            title: "Cyberpunk 2077",
            steam_app_id: "1091500",
            reviews: [
                "https://steamcommunity.com/id/jokerdesu/recommended/1091500/",
                "https://steamcommunity.com/profiles/76561198118956082/recommended/1091500/",
                "https://steamcommunity.com/profiles/76561198842646248/recommended/1091500/",
                "https://steamcommunity.com/profiles/76561197993010115/recommended/1091500/",
                "https://steamcommunity.com/id/mysteriousswede/recommended/1091500/",
                "https://steamcommunity.com/id/masoudbyhimself/recommended/1091500/"
            ]
        },
        {
            title: "The Sims� 4",
            steam_app_id: "1222670",
            reviews: [
                "https://steamcommunity.com/profiles/76561199434648497/recommended/1222670/",
                "https://steamcommunity.com/profiles/76561199178554581/recommended/1222670/",
                "https://steamcommunity.com/id/AllGunny/recommended/1222670/",
                "https://steamcommunity.com/id/chaoguangleisu/recommended/1222670/",
                "https://steamcommunity.com/profiles/76561198171981621/recommended/1222670/",
                "https://steamcommunity.com/profiles/76561199157665393/recommended/1222670/"
            ]
        },
        {
            title: "VRChat",
            steam_app_id: "438100",
            reviews: [
                "https://steamcommunity.com/profiles/76561199012169608/recommended/438100/",
                "https://steamcommunity.com/id/JJNuttyButter/recommended/438100/",
                "https://steamcommunity.com/profiles/76561198025004855/recommended/438100/",
                "https://steamcommunity.com/id/Mokocchi/recommended/438100/",
                "https://steamcommunity.com/id/MoonkingSteam/recommended/438100/",
                "https://steamcommunity.com/id/kinggod374/recommended/438100/"
            ]
        },
        {
            title: "Yu-Gi-Oh! Master Duel",
            steam_app_id: "1449850",
            reviews: [
                "https://steamcommunity.com/id/lelaigod/recommended/1449850/",
                "https://steamcommunity.com/profiles/76561199222389614/recommended/1449850/",
                "https://steamcommunity.com/profiles/76561199132016159/recommended/1449850/",
                "https://steamcommunity.com/profiles/76561199199863275/recommended/1449850/",
                "https://steamcommunity.com/profiles/76561199013688835/recommended/1449850/",
                "https://steamcommunity.com/profiles/76561199215901403/recommended/1449850/"
            ]
        },
        {
            title: "Magic: The Gathering Arena",
            steam_app_id: "2141910",
            reviews: [
                "https://steamcommunity.com/id/noahtheboah36/recommended/2141910/",
                "https://steamcommunity.com/profiles/76561198120815266/recommended/2141910/",
                "https://steamcommunity.com/profiles/76561198415450285/recommended/2141910/",
                "https://steamcommunity.com/profiles/76561198372689483/recommended/2141910/",
                "https://steamcommunity.com/id/RatShadows98/recommended/2141910/",
                "https://steamcommunity.com/profiles/76561198004945792/recommended/2141910/"
            ]
        },
        {
            title: "Undertale",
            steam_app_id: "391540",
            reviews: [
                "https://steamcommunity.com/id/FlibbleBibble/recommended/391540/",
                "https://steamcommunity.com/profiles/76561198864188914/recommended/391540/",
                "https://steamcommunity.com/profiles/76561199012852599/recommended/391540/",
                "https://steamcommunity.com/profiles/76561198342867463/recommended/391540/",
                "https://steamcommunity.com/profiles/76561199068653922/recommended/391540/",
                "https://steamcommunity.com/id/Daeren/recommended/391540/"
            ]
        },
        {
            title: "DELTARUNE",
            steam_app_id: "1671210",
            reviews: [
                "https://steamcommunity.com/profiles/76561199561667522/recommended/1671210/",
                "https://steamcommunity.com/profiles/76561198344848623/recommended/1671210/",
                "https://steamcommunity.com/id/Darkiue/recommended/1671210/",
                "https://steamcommunity.com/profiles/76561199694480721/recommended/1671210/",
                "https://steamcommunity.com/id/Beatzy/recommended/1671210/",
                "https://steamcommunity.com/profiles/76561199152871185/recommended/1671210/"
            ]
        },
        {
            title: "Victoria 3",
            steam_app_id: "529340",
            reviews: [
                "https://steamcommunity.com/id/13S3NT1N3L77/recommended/529340/",
                "https://steamcommunity.com/id/IlliterateSquid/recommended/529340/",
                "https://steamcommunity.com/id/Nemesysbr/recommended/529340/",
                "https://steamcommunity.com/profiles/76561198056265908/recommended/529340/",
                "https://steamcommunity.com/profiles/76561198042641999/recommended/529340/",
                "https://steamcommunity.com/profiles/76561198084636944/recommended/529340/"
            ]
        },
        {
            title: "Destiny 2",
            steam_app_id: "1085660",
            reviews: [
                "https://steamcommunity.com/id/xXx_mtv_xXx/recommended/1085660/",
                "https://steamcommunity.com/id/tipp3x/recommended/1085660/",
                "https://steamcommunity.com/profiles/76561198014839244/recommended/1085660/",
                "https://steamcommunity.com/profiles/76561198064623007/recommended/1085660/",
                "https://steamcommunity.com/profiles/76561199232494297/recommended/1085660/",
                "https://steamcommunity.com/id/xxxfantasy/recommended/1085660/"
            ]
        },
        {
            title: "Geometry Dash",
            steam_app_id: "322170",
            reviews: [
                "https://steamcommunity.com/profiles/76561198241728872/recommended/322170/",
                "https://steamcommunity.com/profiles/76561199864172445/recommended/322170/",
                "https://steamcommunity.com/profiles/76561199231913144/recommended/322170/",
                "https://steamcommunity.com/id/findingerik/recommended/322170/",
                "https://steamcommunity.com/profiles/76561198798972691/recommended/322170/",
                "https://steamcommunity.com/profiles/76561199141604144/recommended/322170/"
            ]
        },
        {
            title: "Don't Starve Together",
            steam_app_id: "322330",
            reviews: [
                "https://steamcommunity.com/id/catgirI/recommended/322330/",
                "https://steamcommunity.com/id/loluaregay/recommended/322330/",
                "https://steamcommunity.com/profiles/76561198847352324/recommended/322330/",
                "https://steamcommunity.com/id/V_M99/recommended/322330/",
                "https://steamcommunity.com/id/Memozz-is-a-hero/recommended/322330/",
                "https://steamcommunity.com/id/LegendLazy/recommended/322330/"
            ]
        },
        {
            title: "PAYDAY 2",
            steam_app_id: "218620",
            reviews: [
                "https://steamcommunity.com/id/naughtykitty666/recommended/218620/",
                "https://steamcommunity.com/id/juberax/recommended/218620/",
                "https://steamcommunity.com/id/thatannoyingcat12/recommended/218620/",
                "https://steamcommunity.com/id/Deerstroyer/recommended/218620/",
                "https://steamcommunity.com/id/0sKu/recommended/218620/",
                "https://steamcommunity.com/id/The_Badger/recommended/218620/"
            ]
        },
        {
            title: "Bloons TD 6",
            steam_app_id: "960090",
            reviews: [
                "https://steamcommunity.com/profiles/76561199625941327/recommended/960090/",
                "https://steamcommunity.com/profiles/76561198269468656/recommended/960090/",
                "https://steamcommunity.com/profiles/76561198021926401/recommended/960090/",
                "https://steamcommunity.com/id/malletcrush/recommended/960090/",
                "https://steamcommunity.com/id/fuze_x/recommended/960090/",
                "https://steamcommunity.com/id/VeeliaX/recommended/960090/"
            ]
        },
        {
            title: "ELDEN RING NIGHTREIGN",
            steam_app_id: "2622380",
            reviews: [
                "https://steamcommunity.com/id/Curtisldavies/recommended/2622380/",
                "https://steamcommunity.com/id/navivan_/recommended/2622380/",
                "https://steamcommunity.com/id/JinnXV/recommended/2622380/",
                "https://steamcommunity.com/id/ravenrinkaa/recommended/2622380/",
                "https://steamcommunity.com/id/benli118118/recommended/2622380/",
                "https://steamcommunity.com/id/a3lzZGJtaWQ/recommended/2622380/"
            ]
        },
        {
            title: "WEBFISHING",
            steam_app_id: "3146520",
            reviews: [
                "https://steamcommunity.com/id/GingernutMoose/recommended/3146520/",
                "https://steamcommunity.com/id/Kogleru/recommended/3146520/",
                "https://steamcommunity.com/id/thealiceofred/recommended/3146520/",
                "https://steamcommunity.com/id/MotionlessPoetry/recommended/3146520/",
                "https://steamcommunity.com/id/sorebones/recommended/3146520/",
                "https://steamcommunity.com/id/pm52/recommended/3146520/"
            ]
        },
        {
            title: "Barony",
            steam_app_id: "371970",
            reviews: [
                "https://steamcommunity.com/id/URG_Executor/recommended/371970/",
                "https://steamcommunity.com/id/Koibu/recommended/371970/",
                "https://steamcommunity.com/id/dawnshalo/recommended/371970/",
                "https://steamcommunity.com/id/notverysubtle/recommended/371970/",
                "https://steamcommunity.com/profiles/76561198996567685/recommended/371970/",
                "https://steamcommunity.com/id/pantsowl/recommended/371970/"
            ]
        },
        {
            title: "Halo: The Master Chief Collection",
            steam_app_id: "976730",
            reviews: [
                "https://steamcommunity.com/id/medina2465/recommended/976730/",
                "https://steamcommunity.com/id/RiFFnTEAR/recommended/976730/",
                "https://steamcommunity.com/id/rekt0ro/recommended/976730/",
                "https://steamcommunity.com/id/OMFGoddess/recommended/976730/",
                "https://steamcommunity.com/id/Spy_Hunter/recommended/976730/",
                "https://steamcommunity.com/profiles/76561199698732163/recommended/976730/"
            ]
        },
        {
            title: "ARMORED CORE� VI FIRES OF RUBICON�",
            steam_app_id: "1888160",
            reviews: [
                "https://steamcommunity.com/profiles/76561198241257916/recommended/1888160/",
                "https://steamcommunity.com/profiles/76561198003434473/recommended/1888160/",
                "https://steamcommunity.com/id/flaptaincappers/recommended/1888160/",
                "https://steamcommunity.com/id/Mulder_JTT047101111/recommended/1888160/",
                "https://steamcommunity.com/profiles/76561198263298647/recommended/1888160/",
                "https://steamcommunity.com/id/1nterstellar/recommended/1888160/"
            ]
        },
        {
            title: "SIGNALIS",
            steam_app_id: "1262350",
            reviews: [
                "https://steamcommunity.com/profiles/76561198043699187/recommended/1262350/",
                "https://steamcommunity.com/id/superawesomekickass/recommended/1262350/",
                "https://steamcommunity.com/profiles/76561198390264836/recommended/1262350/",
                "https://steamcommunity.com/id/iamconsent/recommended/1262350/",
                "https://steamcommunity.com/id/SyntheticHellhound/recommended/1262350/",
                "https://steamcommunity.com/id/yuromilk9/recommended/1262350/"
            ]
        },
        {
            title: "Solar Ash",
            steam_app_id: "1867530",
            reviews: [
                "https://steamcommunity.com/id/vaati_006/recommended/1867530/",
                "https://steamcommunity.com/profiles/76561198088173876/recommended/1867530/",
                "https://steamcommunity.com/id/altairzio/recommended/1867530/",
                "https://steamcommunity.com/id/aglevel/recommended/1867530/",
                "https://steamcommunity.com/id/skilluplayz/recommended/1867530/",
                "https://steamcommunity.com/id/Glazelf/recommended/1867530/"
            ]
        },
        {
            title: "Neon White",
            steam_app_id: "1533420",
            reviews: [
                "https://steamcommunity.com/id/SonEfsane3/recommended/1533420/",
                "https://steamcommunity.com/profiles/76561198008521229/recommended/1533420/",
                "https://steamcommunity.com/id/Simonsyndaren/recommended/1533420/",
                "https://steamcommunity.com/id/AlwaysSleepy0/recommended/1533420/",
                "https://steamcommunity.com/id/sirlagsal0t/recommended/1533420/",
                "https://steamcommunity.com/id/swansbb/recommended/1533420/"
            ]
        },
        {
            title: "Psychonauts 2",
            steam_app_id: "607080",
            reviews: [
                "https://steamcommunity.com/profiles/76561198010209427/recommended/607080/",
                "https://steamcommunity.com/profiles/76561198068726029/recommended/607080/",
                "https://steamcommunity.com/profiles/76561198882082220/recommended/607080/",
                "https://steamcommunity.com/id/soupmasters/recommended/607080/",
                "https://steamcommunity.com/profiles/76561198034199250/recommended/607080/",
                "https://steamcommunity.com/id/thickman420/recommended/607080/"
            ]
        },
        {
            title: "Psychonauts",
            steam_app_id: "3830",
            reviews: [
                "https://steamcommunity.com/profiles/76561198032518991/recommended/3830/",
                "https://steamcommunity.com/id/GajimaMoro/recommended/3830/",
                "https://steamcommunity.com/profiles/76561198259582505/recommended/3830/",
                "https://steamcommunity.com/profiles/76561198186242370/recommended/3830/",
                "https://steamcommunity.com/id/loopuleasa/recommended/3830/",
                "https://steamcommunity.com/id/Thekingofthepiratesbabyyyyy/recommended/3830/"
            ]
        },
        {
            title: "ACE COMBAT� 7: SKIES UNKNOWN",
            steam_app_id: "502500",
            reviews: [
                "https://steamcommunity.com/id/SubwayEatThresh/recommended/502500/",
                "https://steamcommunity.com/profiles/76561199062988146/recommended/502500/",
                "https://steamcommunity.com/profiles/76561198376802797/recommended/502500/",
                "https://steamcommunity.com/profiles/76561198255621670/recommended/502500/",
                "https://steamcommunity.com/profiles/76561198179893841/recommended/502500/",
                "https://steamcommunity.com/id/runeow/recommended/502500/"
            ]
        },
        {
            title: "Rain World",
            steam_app_id: "312520",
            reviews: [
                "https://steamcommunity.com/profiles/76561198092135223/recommended/312520/",
                "https://steamcommunity.com/id/oquinnisi/recommended/312520/",
                "https://steamcommunity.com/profiles/76561198926413446/recommended/312520/",
                "https://steamcommunity.com/profiles/76561199526316321/recommended/312520/",
                "https://steamcommunity.com/id/noonereedus/recommended/312520/",
                "https://steamcommunity.com/id/86492/recommended/312520/"
            ]
        },
        {
            title: "Barotrauma",
            steam_app_id: "602960",
            reviews: [
                "https://steamcommunity.com/profiles/76561198214118412/recommended/602960/",
                "https://steamcommunity.com/id/gigabyte171/recommended/602960/",
                "https://steamcommunity.com/id/questionabledark/recommended/602960/",
                "https://steamcommunity.com/id/Apotarest/recommended/602960/",
                "https://steamcommunity.com/id/TheGrandCanyon/recommended/602960/",
                "https://steamcommunity.com/id/ozwilliam/recommended/602960/"
            ]
        },
        {
            title: "Poco",
            steam_app_id: "3454610",
            reviews: [
                "https://steamcommunity.com/id/T10SOLITAIRE/recommended/3454610/",
                "https://steamcommunity.com/id/lullaby-of-time/recommended/3454610/",
                "https://steamcommunity.com/profiles/76561198327799680/recommended/3454610/",
                "https://steamcommunity.com/profiles/76561199796244019/recommended/3454610/",
                "https://steamcommunity.com/profiles/76561198426482832/recommended/3454610/",
                "https://steamcommunity.com/id/PrincessKara/recommended/3454610/"
            ]
        },
        {
            title: "Limbus Company",
            steam_app_id: "1973530",
            reviews: [
                "https://steamcommunity.com/profiles/76561199231176078/recommended/1973530/",
                "https://steamcommunity.com/profiles/76561198198701690/recommended/1973530/",
                "https://steamcommunity.com/id/Tsuttan/recommended/1973530/",
                "https://steamcommunity.com/profiles/76561198834855056/recommended/1973530/",
                "https://steamcommunity.com/profiles/76561198198701690/recommended/1973530/",
                "https://steamcommunity.com/profiles/76561199083033455/recommended/1973530/"
            ]
        },
        {
            title: "Stray",
            steam_app_id: "1332010",
            reviews: [
                "https://steamcommunity.com/profiles/76561198386518711/recommended/1332010/",
                "https://steamcommunity.com/id/daizbid/recommended/1332010/",
                "https://steamcommunity.com/id/roastytoasty/recommended/1332010/",
                "https://steamcommunity.com/id/zeusbuilt/recommended/1332010/",
                "https://steamcommunity.com/id/TheSindarianKing/recommended/1332010/",
                "https://steamcommunity.com/id/IsonDaya/recommended/1332010/"
            ]
        },
        {
            title: "REMNANT II",
            steam_app_id: "1282100",
            reviews: [
                "https://steamcommunity.com/id/ForceInept/recommended/1282100/",
                "https://steamcommunity.com/profiles/76561198344876684/recommended/1282100/",
                "https://steamcommunity.com/profiles/76561197998371036/recommended/1282100/",
                "https://steamcommunity.com/id/raudrick/recommended/1282100/",
                "https://steamcommunity.com/profiles/76561198132595581/recommended/1282100/",
                "https://steamcommunity.com/id/gentleb/recommended/1282100/"
            ]
        },
        {
            title: "Phasmophobia",
            steam_app_id: "739630",
            reviews: [
                "https://steamcommunity.com/id/TylerPark/recommended/739630/",
                "https://steamcommunity.com/id/givemegamespls/recommended/739630/",
                "https://steamcommunity.com/id/kwytz_/recommended/739630/",
                "https://steamcommunity.com/id/Mogul162/recommended/739630/",
                "https://steamcommunity.com/profiles/76561198155350524/recommended/739630/",
                "https://steamcommunity.com/id/WitchPa1ace/recommended/739630/"
            ]
        },
        {
            title: "Content Warning",
            steam_app_id: "2881650",
            reviews: [
                "https://steamcommunity.com/profiles/76561198377109887/recommended/2881650/",
                "https://steamcommunity.com/id/wlr757/recommended/2881650/",
                "https://steamcommunity.com/profiles/76561199020970251/recommended/2881650/",
                "https://steamcommunity.com/profiles/76561199072613057/recommended/2881650/",
                "https://steamcommunity.com/id/Akuairopalette/recommended/2881650/",
                "https://steamcommunity.com/profiles/76561198209194904/recommended/2881650/"
            ]
        },
        {
            title: "BELOW",
            steam_app_id: "250680",
            reviews: [
                "https://steamcommunity.com/id/Dikie13ingo/recommended/250680/",
                "https://steamcommunity.com/profiles/76561198799958481/recommended/250680/",
                "https://steamcommunity.com/profiles/76561199131435587/recommended/250680/",
                "https://steamcommunity.com/profiles/76561198036754085/recommended/250680/",
                "https://steamcommunity.com/id/YourKingMob/recommended/250680/",
                "https://steamcommunity.com/id/imjezze/recommended/250680/"
            ]
        },
        {
            title: "NieR Replicant™ ver.1.22474487139...",
            steam_app_id: "1113560",
            reviews: [
                "https://steamcommunity.com/id/GregorRisenwald/recommended/1113560/",
                "https://steamcommunity.com/id/bartas4550/recommended/1113560/",
                "https://steamcommunity.com/profiles/76561198051959783/recommended/1113560/",
                "https://steamcommunity.com/id/XxHidanxX/recommended/1113560/",
                "https://steamcommunity.com/profiles/76561198806214254/recommended/1113560/",
                "https://steamcommunity.com/profiles/76561198859283781/recommended/1113560/"
            ]
        },
        {
            title: "LOCKDOWN Protocol",
            steam_app_id: "2780980",
            reviews: [
                "https://steamcommunity.com/id/setzera/recommended/2780980/",
                "https://steamcommunity.com/id/123456789810/recommended/2780980/",
                "https://steamcommunity.com/profiles/76561199470353699/recommended/2780980/",
                "https://steamcommunity.com/profiles/76561199176792153/recommended/2780980/",
                "https://steamcommunity.com/profiles/76561198953717132/recommended/2780980/",
                "https://steamcommunity.com/id/spellynelly/recommended/2780980/"
            ]
        },
        {
            title: "Guild Wars 2",
            steam_app_id: "1284210",
            reviews: [
                "https://steamcommunity.com/profiles/76561197994051630/recommended/1284210/",
                "https://steamcommunity.com/profiles/76561198410433055/recommended/1284210/",
                "https://steamcommunity.com/profiles/76561198049436351/recommended/1284210/",
                "https://steamcommunity.com/id/egssucks/recommended/1284210/",
                "https://steamcommunity.com/id/XiiDraco/recommended/1284210/",
                "https://steamcommunity.com/id/koozebane/recommended/1284210/"
            ]
        },
                {
            title: "",
            steam_app_id: "",
            reviews: [
                "",
                "",
                "",
                "",
                "",
                ""
            ]
        },

        // {
        //     title: "Your Next Game Title",
        //     steam_app_id: "YOUR_APP_ID",
        //     reviews: [
        //         "https://steamcommunity.com/link/to/review1",
        //         "https://steamcommunity.com/link/to/review2",
        //         "https://steamcommunity.com/link/to/review3",
        //         "https://steamcommunity.com/link/to/review4",
        //         "https://steamcommunity.com/link/to/review5",
        //         "https://steamcommunity.com/link/to/review6"
        //     ]
        // }
        // Add more game objects here
    ];

    if (!gamesToSeed || gamesToSeed.length === 0) {
        console.warn("[SEED_WARN] 'gamesToSeed' array is empty. No data will be seeded or cleaned up.");
        return;
    }

    // Get all current game titles from the database to compare against gamesToSeed
    const dbGames = await new Promise((resolve, reject) => {
        db.all("SELECT id, title FROM games", (err, rows) => {
            err ? reject(err) : resolve(rows);
        });
    });

    const titlesToSeed = gamesToSeed.map(g => g.title);
    const titlesInDb = dbGames.map(g => g.title);

    // 1. Process games in gamesToSeed (Upsert: Update existing, Insert new)
    for (const gameData of gamesToSeed) {
        

        // Basic validation
        if (!gameData.title || !gameData.steam_app_id || !Array.isArray(gameData.reviews) || gameData.reviews.length === 0) {
            console.error(`[SEED_ERROR] Invalid data for "${gameData.title || 'UNTITLED'}". Skipping.`);
            continue;
        }
        if (gameData.reviews.length !== 6) {
            console.warn(`[SEED_WARN] Game "${gameData.title}" has ${gameData.reviews.length} review URLs, expected 6. Game clues might be incomplete.`);
        }

        try {
            const existingGame = dbGames.find(g => g.title === gameData.title);
            let gameId;

            if (existingGame) {
                gameId = existingGame.id;
                console.log(`[SEED_INFO] Game "${gameData.title}" (ID: ${gameId}) exists. Checking for AppID update and re-seeding reviews.`);
                // Update steam_app_id if different
                if (existingGame.steam_app_id !== gameData.steam_app_id) {
                    await new Promise((resolve, reject) => {
                        db.run("UPDATE games SET steam_app_id = ? WHERE id = ?", [gameData.steam_app_id, gameId], function (err) {
                            this.changes > 0 ? console.log(`[SEED_SUCCESS] Updated AppID for "${gameData.title}".`) : console.log(`[SEED_INFO] AppID for "${gameData.title}" is current.`);
                            err ? reject(err) : resolve();
                        });
                    });
                }
                // Delete old reviews for this game to ensure fresh list
                await new Promise((resolve, reject) => {
                    db.run("DELETE FROM game_reviews WHERE game_id = ?", [gameId], (err) => {
                        console.log(`[SEED_INFO] Deleted existing reviews for Game ID ${gameId} ("${gameData.title}") to prepare for re-seed.`);
                        err ? reject(err) : resolve();
                    });
                });
            } else {
                console.log(`[SEED_INFO] Game "${gameData.title}" is new. Inserting.`);
                const result = await new Promise((resolve, reject) => {
                    db.run("INSERT INTO games (title, steam_app_id) VALUES (?, ?)", [gameData.title, gameData.steam_app_id], function (err) {
                        if (err) {
                            console.error(`[SEED_DB_ERROR] Error inserting new game "${gameData.title}":`, err.message);
                            reject(err);
                        } else {
                            
                            resolve(this.lastID);
                        }
                    });
                });
                gameId = result;
            }

            // Insert current reviews for this game
            for (let i = 0; i < gameData.reviews.length; i++) {
                const reviewPageUrl = gameData.reviews[i];
                if (!reviewPageUrl || typeof reviewPageUrl !== 'string' || !(reviewPageUrl.toLowerCase().startsWith('http://') || reviewPageUrl.toLowerCase().startsWith('https://'))) {
                    console.error(`[SEED_ERROR] Invalid review page URL for "${gameData.title}", URL ${i + 1}: "${reviewPageUrl}". Skipping.`);
                    continue;
                }
                await new Promise((resolve_rev, reject_rev) => {
                    db.run("INSERT OR IGNORE INTO game_reviews (game_id, review_page_url, clue_order) VALUES (?, ?, ?)",
                        [gameId, reviewPageUrl, i + 1], function (err_rev) { // Use function for this.changes
                            if (err_rev) {
                                console.error(`[SEED_DB_ERROR] Error inserting review URL "${reviewPageUrl}" for Game ID ${gameId}:`, err_rev.message);
                                reject_rev(err_rev);
                            } else {
                                if (this.changes > 0) {
                                    console.log(`[SEED_SUCCESS] Inserted review URL ${i + 1} for Game ID ${gameId}.`);
                                } else {
                                    console.log(`[SEED_INFO] Review URL ${i + 1} ("${reviewPageUrl}") for Game ID ${gameId} was not inserted (possibly already exists and matched UNIQUE constraint).`);
                                }
                                resolve_rev();
                            }
                        });
                });
            }
        } catch (err) {
            console.error(`[SEED_EXCEPTION] During upsert for "${gameData.title || 'UNTITLED'}":`, err.message, err.stack);
        }
    }

    // 2. Clean up: Remove games from DB that are no longer in gamesToSeed
    for (const dbGame of dbGames) {
        if (!titlesToSeed.includes(dbGame.title)) {
            console.log(`[SEED_INFO] Game "${dbGame.title}" (ID: ${dbGame.id}) is in DB but not in seed list. Deleting.`);
            try {
                await new Promise((resolve, reject) => {
                    // FOREIGN KEY ON DELETE CASCADE will also remove its reviews
                    db.run("DELETE FROM games WHERE id = ?", [dbGame.id], (err) => {
                        if (err) {
                            console.error(`[SEED_DB_ERROR] Error deleting obsolete game "${dbGame.title}":`, err.message);
                            reject(err);
                        } else {
                            console.log(`[SEED_SUCCESS] Deleted obsolete game "${dbGame.title}".`);
                            resolve();
                        }
                    });
                });
            } catch (err) {
                console.error(`[SEED_EXCEPTION] During cleanup of "${dbGame.title}":`, err.message);
            }
        }
    }

    console.log("[SEED_INFO] --- Finished seedInitialData (Upsert & Cleanup Mode) ---");
}

module.exports = db;