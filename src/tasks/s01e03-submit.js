import { sendAnswer } from '../utils/api.js';

// Replace with your actual public URL once the server is deployed
const PUBLIC_URL = 'https://azyl-58775.ag3nts.org';

const result = await sendAnswer('proxy', {
  url: PUBLIC_URL,
  sessionID: 'session02'
});

console.log(result);
