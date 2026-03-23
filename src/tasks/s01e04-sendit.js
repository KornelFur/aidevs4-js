import axios from 'axios';
import { chat, MODELS } from '../utils/openrouter.js'
import { sendAnswer } from '../utils/api.js';

// -----------------------------------------------------------------------
// STEP 1: fetching documentation and understanding the task
// -----------------------------------------------------------------------

async function fetchDocumentation() {
    const url = 'https://hub.ag3nts.org/dane/doc/';
    const response = await axios.get(url + 'index.md');
    //console.log(response.data);
    return response.data;
}

const docs = await fetchDocumentation();

// find included files and fetch them as well
function extractIncludes(text) {
  const regex = /\[include file="([^"]+)"\]/g;
  const matches = [...text.matchAll(regex)];
  return matches.map(m => m[1]);
}

const fileNames = extractIncludes(docs);
// console.log('Included files:', fileNames);

// -----------------------------------------------------------------------
// STEP 2: fetching included files 
// -----------------------------------------------------------------------

async function fetchAllFiles(fileNames) {
    const results = {};
    for (const fileName of fileNames) {
        if (fileName.endsWith('.md')) {
            const url = 'https://hub.ag3nts.org/dane/doc/' + fileName;
            const response = await axios.get(url);
            results[fileName] = response.data;
        } else if (fileName.endsWith('.png')) {
            const url = 'https://hub.ag3nts.org/dane/doc/' + fileName;
            const response = await axios.get(url, { responseType: 'arraybuffer'});
            results[fileName] = response.data;       
    }
    }
    return results;
}

const files = await fetchAllFiles(fileNames);
// console.log(Object.keys(files));
// console.log(files['zalacznik-E.md']);


// -----------------------------------------------------------------------
// STEP 3: send image to vision model
// -----------------------------------------------------------------------

async function extractImageText(imageBuffer) {
    const base64 = imageBuffer.toString('base64');

const messages = [
    {
        role: 'user',
        content: [
            { type: 'text', text: 'Przepisz dokładnie całą tabelę z tego obrazka jako tekst markdown.'},
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`}}
        ]
    }
];

return await chat(messages, MODELS.GEMINI3_1);
}

const tableText = await extractImageText(files['trasy-wylaczone.png']);
// console.log(tableText);


// -----------------------------------------------------------------------
// STEP 4: prepare a declaration based on included files
// -----------------------------------------------------------------------

function buildContext(files, tableText) {
    let context = '';

    for (const [name, content] of Object.entries(files)) {
        if (name.endsWith('.md')) {
            context += `\n\n=== ${name} ===\n${content}`;
        }
    }
    context += `\n\n=== trasy-wylaczone.png (tabela) ===\n${tableText}`;
    return context;
}

const context = buildContext(files, tableText);
console.log(context)

async function fillDeclaration(context) {
    const messages = [
        {
            role: 'system',
            content: 'Jesteś ekspertem od Systemu Przesyłek Konduktorskich. Wypełnij deklarację transportu na podstawie dokumentacji i podanych danych. Zwróc tylko gotowy tekst deklaracji, sformatowany dokładnie jak wzór z dokumentacji.'
        },
        {
            role: 'user',
            content: `Dokumentacja:\n${context}

            Data deklaracji: format YYYY-MM-DD, bez nawiasów kwadratowych
            Dane przesyłki:
            - Nadawca: 450202122
            - Punkt nadawczy: Gdańsk
            - Punkt docelowy: Żarnowiec
            - Waga: 2,8 tony
            - Budzet: 0 PP (przesyłka ma być darmowa lub finansowana przez system)
            - Zawartość: kasety z paliwem do reaktora
            - Uwagi specjalne: brak - nie dodawaj zadnych uwag`
        }
    ];
    
    return await chat(messages, MODELS.GPT4O)
}

const declaration = await fillDeclaration(context)
console.log(declaration)


const result = await sendAnswer('sendit', { declaration });
console.log(result);