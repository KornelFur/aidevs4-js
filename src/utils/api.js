import axios from 'axios';

export const API_KEY = process.env.AIDEVS4_API_KEY;
export const BASE_URL = 'https://hub.ag3nts.org';

export async function fetchData(filename) {
  const url = `${BASE_URL}/data/${API_KEY}/${filename}`;
  const response = await axios.get(url);
  return response.data;
}

export async function sendAnswer(task, answer) {
  const url = `${BASE_URL}/verify`;
  const response = await axios.post(url, {
    apikey: API_KEY,
    task: task,
    answer: answer,
  });
  return response.data;
}
