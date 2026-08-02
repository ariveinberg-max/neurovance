import 'dotenv/config';
import { runTask } from './agent.js';

const task = process.argv.slice(2).join(' ');

if (!task) {
  console.log('Usage: npm start "your task or question here"');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('No ANTHROPIC_API_KEY found. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const result = await runTask(task);
console.log(result);
