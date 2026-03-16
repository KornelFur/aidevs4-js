import { fetchData, BASE_URL, API_KEY } from '../utils/api.js';
import { chat, MODELS, agent } from '../utils/openrouter.js';
import axios from 'axios';

// Suspects identified in s01e01-people task
const SUSPECTS = [
  {
    "name": "Cezary",
    "surname": "Żurek",
    "gender": "M",
    "born": 1987,
    "city": "Grudziądz",
    "tags": [
      "transport"
    ]
  },
  {
    "name": "Jacek",
    "surname": "Nowak",
    "gender": "M",
    "born": 1991,
    "city": "Grudziądz",
    "tags": [
      "transport"
    ]
  },
  {
    "name": "Wojciech",
    "surname": "Bielik",
    "gender": "M",
    "born": 1986,
    "city": "Grudziądz",
    "tags": [
      "transport"
    ]
  },
  {
    "name": "Wacław",
    "surname": "Jasiński",
    "gender": "M",
    "born": 1986,
    "city": "Grudziądz",
    "tags": [
      "transport"
    ]
  }
]

// Step 1: Fetch the list of nuclear power plants
const locations = await fetchData('findhim_locations.json');
console.log(JSON.stringify(locations, null, 2));

// Step 2: Fetch the coordinates where a specific suspect was seen (location)
const coordinates = async function(suspect) {
    const url = `${BASE_URL}/api/location`;
    const response = await axios.post(url, {
        apikey: API_KEY,
        name: suspect.name,
        surname: suspect.surname,
    });
    return response.data;
}

for (const suspect of SUSPECTS) {
    const coord = await coordinates(suspect);
    console.log(`${suspect.name} ${suspect.surname}: response: ${JSON.stringify(coord)}`);
}

// Step 3: send suspect.city to Nominatim API and get the coordinates of the city center
const geocodeCity = async function(city) {
    const url = `https://nominatim.openstreetmap.org/search`;
    const response = await axios.get(url, {
        params: {
            q: city,
            format: 'json',
            limit: 1
        },
        headers: {
            'User-Agent': 'agent5/1.0'
        }
    });
    return response.data[0];
}

for (const cityName of Object.keys(locations.power_plants)) {
    const cityCord = await geocodeCity(cityName);
    console.log('-------');
    console.log(`${cityName}: latitude: ${JSON.stringify(cityCord.lat)}, longitude: ${JSON.stringify(cityCord.lon)}`);
}

// Step 4: compare the coordinates with the locations of nuclear power plants and find out if any suspect was seen near any of them
// Haversine formula — calculates distance in km between two points on Earth
// lat/lon must be numbers (not strings)
const calculateDistance = function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const toRad = (deg) => deg * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // distance in km
}


// Step 5: what level of access does the indicated suspect have
const getSuspectAccessLevel = async function(suspect) {
    const url = `${BASE_URL}/api/accesslevel`;
    const response = await axios.post(url, {
        apikey: API_KEY,
        name: suspect.name,
        surname: suspect.surname,
        birthYear: suspect.born
    });
    return response.data;
}

for (const suspect of SUSPECTS) {
    const accessLevel = await getSuspectAccessLevel(suspect);
    console.log(`${suspect.name} ${suspect.surname}: access level: ${JSON.stringify(accessLevel)}`);
}

// Step 6: create tools for LLM to query the data and answer questions about suspects, locations, and power plants
// Tools its a restaurant menu (LLM knows what can order), tollHandlers its a kitchen that prepares the order and returns it to LLM
const tools = [
    {
        type: 'function',
        function: {
            name: 'getLocationHistory',
            description: 'Return list of coordinates where the suspect was seen',
            parameters: {
                type: 'object',
                properties: {
                    name: {type: 'string', description: "First name of the suspect"},
                    surname: {type: 'string', description: "Last name of the suspect"},
                },
                required: ['name', 'surname']
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'geocodeCity',
            description: 'Return coordinates of the city center',
            parameters: {
                type: 'object',
                properties: {
                    city: {type: 'string', description: "Name of the city"},
                },
                required: ['city']
            },
        }
    },
    {
        type: 'function',
        function: {
            name: 'calculateDistance',
            description: 'Calculate distance between two points on Earth using Haversine formula',
            parameters: {
                type: 'object',
                properties: {
                    lat1: {type: 'number', description: "Latitude of the first point"},
                    lon1: {type: 'number', description: "Longitude of the first point"},
                    lat2: {type: 'number', description: "Latitude of the second point"},
                    lon2: {type: 'number', description: "Longitude of the second point"},
                },
                required: ['lat1', 'lon1', 'lat2', 'lon2']
            },
        }
    },
    {
        type: 'function',
        function: {
            name: 'getSuspectAccessLevel',
            description: 'Return the level of access the suspect has',
            parameters: {
                type: 'object',
                properties: {
                    name: {type: 'string', description: "First name of the suspect"},
                    surname: {type: 'string', description: "Last name of the suspect"},
                    birthYear: {type: 'number', description: "Birth year of the suspect"}
                },
                required: ['name', 'surname', 'birthYear']
            },
        }
    },
    {
        type: 'function',
        function: {
            name: 'sendAnswer',
            description: 'Send the final answer to the server',
            parameters: {
                type: 'object',
                properties: {
                    name: {type: 'string', description: "First name of the suspect"},
                    surname: {type: 'string', description: "Last name of the suspect"},
                    accessLevel: {type: 'number', description: "Access level of the suspect"},
                    powerPlant: {type: 'string', description: "Power plant code in format PWR0000PL"},
                },
                required: ['name', 'surname', 'accessLevel', 'powerPlant']
            },
        }
    }   
]

const sendAnswer =  async (args) => {
    const response = await axios.post(`${BASE_URL}/verify`, {
        apikey: API_KEY,
        task: 'findhim',
        answer: {
            name: args.name,
            surname: args.surname,
            accessLevel: args.accessLevel,
            powerPlant: args.powerPlant,
        }
    });
    console.log('API response:', JSON.stringify(response.data));
    return response.data;
}

// Step 7: create a toolsHandlers object that implements the logic of each tool (the kitchen)
const toolHandlers = {
    getLocationHistory: async (args) => {
        return await coordinates({name: args.name, surname: args.surname});
    },
    geocodeCity: async (args) => {
        return await geocodeCity(args.city);
    },
    calculateDistance: async (args) => {
        return calculateDistance(args.lat1, args.lon1, args.lat2, args.lon2);
    },
    getSuspectAccessLevel: async (args) => {
        return await getSuspectAccessLevel({name: args.name, surname: args.surname, born: args.birthYear});
    },
    sendAnswer: async (args) => {
        return await sendAnswer(args);
    }
}

// Step 8: create a system prompt that describes the task and the tools to the LLM
const systemPrompt = `
You are an assistant for a secret agent investigating. 
Your task is to identify which of the suspects is the one who has been seen near nuclear power plants and what level of access they have.
Hera are the suspects:
${JSON.stringify(SUSPECTS, null, 2)}

Here are the locations of nuclear power plants:
${JSON.stringify(locations.power_plants, null, 2)}

You have access to the following tools:
1. getLocationHistory(name, surname) - returns list of coordinates where the suspect was seen
2. geocodeCity(city) - returns coordinates of the city center
3. calculateDistance(lat1, lon1, lat2, lon2) - calculates distance between two points on Earth using Haversine formula
4. getSuspectAccessLevel(name, surname, birthYear) - returns the level of access the suspect has
5. sendAnswer(task, answer) - sends the final answer to the server

After identifying the suspect, you must call sendAnswer function. Task name is 'findhim'.
JSON example: 
{
  "apikey": "tutaj-twój-klucz",
  "task": "findhim",
  "answer": {
    "name": "First name of the suspect",
    "surname": "Last name of the suspect",
    "accessLevel":"Level of access the suspect has",
    "powerPlant": "Power plant code in format PWR + four digits + 2 letters"
  }
}
`

// Step 9: run the agent
const result = await agent (systemPrompt, tools, toolHandlers, MODELS.GPT5_MINI);
console.log('Agent final answer:', result);