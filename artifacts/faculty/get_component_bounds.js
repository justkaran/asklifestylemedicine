import fs from 'fs';

const content = fs.readFileSync('src/App.tsx', 'utf-8');

function getBounds(name) {
    const regex = new RegExp(`(?:export\\s+)?function ${name}\\s*\\([^)]*\\)\\s*({)`);
    const match = content.match(regex);
    
    // Some functions might have complex types in signature, let's just find the function name and its block.
    // simpler: search for "function NAME" and then find the FIRST '{' after it that's NOT inside a comment.
    // Actually, just find the `function NAME` and count braces.
    const startRegex = new RegExp(`(?:export\\s+)?function ${name}[\\s<\\(]`);
    const m = content.match(startRegex);
    if (!m) return;
    
    const start = m.index;
    let end = start;
    let braces = 0;
    let started = false;
    let inString = false;
    let stringChar = '';
    
    for (let i = start; i < content.length; i++) {
        if (!inString) {
            if (content[i] === "'" || content[i] === '"' || content[i] === '`') {
                inString = true;
                stringChar = content[i];
            } else if (content[i] === '{') {
                braces++;
                started = true;
            } else if (content[i] === '}') {
                braces--;
            }
        } else {
            if (content[i] === stringChar && content[i-1] !== '\\') {
                inString = false;
            }
        }
        
        if (started && braces === 0) {
            end = i + 1;
            break;
        }
    }
    const linesBefore = content.substring(0, start).split('\n').length;
    const totalLines = content.substring(start, end).split('\n').length;
    console.log(`${name}: ${linesBefore} to ${linesBefore + totalLines - 1}`);
}

['LandingLivePillars', 'Landing', 'PortalShell', 'TwoPathsPanel', 'StewardProcesses', 'Welcome', 'WhyPalonurPanel'].forEach(getBounds);
