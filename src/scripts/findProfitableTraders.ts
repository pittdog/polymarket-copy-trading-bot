import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const colors = {
    cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
    green: (text: string) => `\x1b[32m${text}\x1b[0m`,
    red: (text: string) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
    blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
    gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
    magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
};

interface TraderProfile {
    address: string;
    name?: string;
    pnl: number;
    volume: number;
    positions: number;
    markets: number;
}

interface Position {
    conditionId: string;
    title: string;
    outcome: string;
    size: number;
    avgPrice: number;
    currentPrice: number;
    value: number;
    pnl: number;
    pnlPercent: number;
}

interface TraderAnalysis {
    address: string;
    name?: string;
    totalPnl: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalVolume: number;
    positionCount: number;
    winningPositions: number;
    losingPositions: number;
    winRate: number;
    avgPnlPerPosition: number;
    bestPosition: Position | null;
    worstPosition: Position | null;
}

const MAX_TRADERS = parseInt(process.env.MAX_TRADERS || '30');

async function fetchLeaderboardTraders(): Promise<string[]> {
    console.log(colors.cyan('📊 Fetching top traders from Polymarket leaderboard...\n'));

    try {
        // Fetch the leaderboard page and extract trader addresses
        const response = await axios.get('https://polymarket.com/leaderboard', {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        const html = response.data;
        const matches = html.matchAll(/href="\/profile\/(0x[a-fA-F0-9]{40})"/g);
        const traders = new Set<string>();

        for (const match of matches) {
            traders.add(match[1].toLowerCase());
        }

        const traderList = Array.from(traders).slice(0, MAX_TRADERS);
        console.log(colors.green(`✓ Found ${traderList.length} traders from leaderboard\n`));
        return traderList;
    } catch (error) {
        console.error(colors.red('Failed to fetch leaderboard:'), error);
        return [];
    }
}

async function fetchTraderPositions(address: string): Promise<any[]> {
    try {
        const response = await axios.get(`https://data-api.polymarket.com/positions`, {
            params: {
                user: address,
                sizeThreshold: 0.01,
            },
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
            },
        });
        return response.data || [];
    } catch {
        return [];
    }
}

async function fetchTraderActivity(address: string, limit: number = 200): Promise<any[]> {
    try {
        const response = await axios.get(`https://data-api.polymarket.com/activity`, {
            params: {
                user: address,
                limit,
            },
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
            },
        });
        return response.data || [];
    } catch {
        return [];
    }
}

async function analyzeTrader(address: string): Promise<TraderAnalysis | null> {
    try {
        const [positions, activity] = await Promise.all([
            fetchTraderPositions(address),
            fetchTraderActivity(address, 500),
        ]);

        if (positions.length === 0 && activity.length === 0) {
            return null;
        }

        // Calculate PnL from positions
        let realizedPnl = 0;
        let unrealizedPnl = 0;
        let totalVolume = 0;
        let winningPositions = 0;
        let losingPositions = 0;

        const analyzedPositions: Position[] = [];

        for (const pos of positions) {
            const size = parseFloat(pos.size) || 0;
            const currentValue = parseFloat(pos.currentValue) || 0;
            const cashBalance = parseFloat(pos.cashBalance) || 0;

            // Estimate invested amount from cash balance or activity
            const invested = Math.abs(cashBalance);
            const pnl = currentValue - invested;
            const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;

            if (size > 0) {
                unrealizedPnl += pnl;
                totalVolume += invested;

                if (pnl > 0) winningPositions++;
                else if (pnl < 0) losingPositions++;

                analyzedPositions.push({
                    conditionId: pos.conditionId,
                    title: pos.title || 'Unknown',
                    outcome: pos.outcome || 'Unknown',
                    size,
                    avgPrice: invested / size,
                    currentPrice: currentValue / size,
                    value: currentValue,
                    pnl,
                    pnlPercent,
                });
            }
        }

        // Calculate realized PnL from closed trades
        const trades = activity.filter((a: any) => a.type === 'TRADE');
        const buyVolume = trades
            .filter((t: any) => t.side === 'BUY')
            .reduce((sum: number, t: any) => sum + (parseFloat(t.usdcSize) || 0), 0);
        const sellVolume = trades
            .filter((t: any) => t.side === 'SELL')
            .reduce((sum: number, t: any) => sum + (parseFloat(t.usdcSize) || 0), 0);

        realizedPnl = sellVolume - buyVolume + unrealizedPnl;
        totalVolume = Math.max(totalVolume, buyVolume);

        // Sort positions by PnL
        analyzedPositions.sort((a, b) => b.pnl - a.pnl);

        const totalPnl = realizedPnl;
        const positionCount = positions.length;
        const winRate = positionCount > 0 ? (winningPositions / positionCount) * 100 : 0;

        // Get trader name from activity
        const name = activity[0]?.name || activity[0]?.pseudonym || undefined;

        return {
            address,
            name,
            totalPnl,
            realizedPnl,
            unrealizedPnl,
            totalVolume,
            positionCount,
            winningPositions,
            losingPositions,
            winRate,
            avgPnlPerPosition: positionCount > 0 ? totalPnl / positionCount : 0,
            bestPosition: analyzedPositions[0] || null,
            worstPosition: analyzedPositions[analyzedPositions.length - 1] || null,
        };
    } catch (error) {
        console.error(colors.gray(`  Error analyzing ${address.slice(0, 10)}...`));
        return null;
    }
}

function formatNumber(num: number): string {
    if (Math.abs(num) >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (Math.abs(num) >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toFixed(0);
}

function formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function printResults(results: TraderAnalysis[]) {
    console.log('\n' + colors.cyan('═'.repeat(110)));
    console.log(colors.cyan('  💰 PROFITABLE TRADERS ANALYSIS'));
    console.log(colors.cyan('═'.repeat(110)) + '\n');

    // Sort by total PnL
    const sortedByPnl = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
    const profitable = sortedByPnl.filter(t => t.totalPnl > 0);
    const unprofitable = sortedByPnl.filter(t => t.totalPnl <= 0);

    console.log(colors.bold(colors.green(`📈 TOP PROFITABLE TRADERS (${profitable.length} found):\n`)));

    if (profitable.length === 0) {
        console.log(colors.yellow('  No profitable traders found in this batch.\n'));
    } else {
        console.log(colors.gray('  Rank | Trader                                     | Name           | PnL          | Volume       | Positions | Win Rate'));
        console.log(colors.gray('  ' + '-'.repeat(105)));

        profitable.slice(0, 20).forEach((t, idx) => {
            const rank = String(idx + 1).padStart(4);
            const name = (t.name || '').slice(0, 14).padEnd(14);
            const pnl = `+$${formatNumber(t.totalPnl)}`.padStart(12);
            const vol = `$${formatNumber(t.totalVolume)}`.padStart(12);
            const pos = String(t.positionCount).padStart(9);
            const winRate = `${t.winRate.toFixed(0)}%`.padStart(8);

            console.log(
                `  ${colors.green(rank)} | ${colors.blue(formatAddress(t.address))} ${colors.gray(t.address.slice(6, -4))} | ${name} | ${colors.green(pnl)} | ${vol} | ${pos} | ${winRate}`
            );
        });
    }

    // Show some losers for comparison
    console.log('\n' + colors.bold(colors.red(`📉 LOSING TRADERS (${unprofitable.length} found):\n`)));

    if (unprofitable.length > 0) {
        console.log(colors.gray('  Rank | Trader                                     | Name           | PnL          | Volume       | Positions | Win Rate'));
        console.log(colors.gray('  ' + '-'.repeat(105)));

        unprofitable.slice(0, 10).forEach((t, idx) => {
            const rank = String(idx + 1).padStart(4);
            const name = (t.name || '').slice(0, 14).padEnd(14);
            const pnl = `-$${formatNumber(Math.abs(t.totalPnl))}`.padStart(12);
            const vol = `$${formatNumber(t.totalVolume)}`.padStart(12);
            const pos = String(t.positionCount).padStart(9);
            const winRate = `${t.winRate.toFixed(0)}%`.padStart(8);

            console.log(
                `  ${colors.red(rank)} | ${colors.blue(formatAddress(t.address))} ${colors.gray(t.address.slice(6, -4))} | ${name} | ${colors.red(pnl)} | ${vol} | ${pos} | ${winRate}`
            );
        });
    }

    // Summary
    console.log('\n' + colors.cyan('═'.repeat(110)));
    console.log(colors.bold('\n📊 SUMMARY:\n'));

    const totalPnl = results.reduce((sum, t) => sum + t.totalPnl, 0);
    const avgPnl = results.length > 0 ? totalPnl / results.length : 0;
    const avgWinRate = results.reduce((sum, t) => sum + t.winRate, 0) / results.length;

    console.log(`  Total traders analyzed: ${results.length}`);
    console.log(`  Profitable traders: ${colors.green(String(profitable.length))} (${((profitable.length / results.length) * 100).toFixed(1)}%)`);
    console.log(`  Unprofitable traders: ${colors.red(String(unprofitable.length))}`);
    console.log(`  Average PnL: ${avgPnl >= 0 ? colors.green('+') : colors.red('')}$${formatNumber(avgPnl)}`);
    console.log(`  Average win rate: ${avgWinRate.toFixed(1)}%`);

    // Recommendations
    if (profitable.length > 0) {
        console.log(colors.bold(colors.magenta('\n💡 RECOMMENDED TRADERS TO COPY:\n')));

        const recommended = profitable.slice(0, 5);
        for (const t of recommended) {
            console.log(`  ${colors.green('→')} ${colors.blue(t.address)}`);
            console.log(`    ${t.name ? `"${t.name}" - ` : ''}PnL: +$${formatNumber(t.totalPnl)} | Win Rate: ${t.winRate.toFixed(0)}% | Volume: $${formatNumber(t.totalVolume)}`);
            console.log(`    Profile: https://polymarket.com/profile/${t.address}`);
            console.log('');
        }
    }

    console.log(colors.cyan('═'.repeat(110)) + '\n');
}

function saveResults(results: TraderAnalysis[]) {
    const resultsDir = path.join(process.cwd(), 'profitable_traders_results');
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `profitable_${timestamp}.json`;
    const filepath = path.join(resultsDir, filename);

    const sortedByPnl = [...results].sort((a, b) => b.totalPnl - a.totalPnl);

    const data = {
        timestamp: Date.now(),
        totalAnalyzed: results.length,
        profitableCount: results.filter(t => t.totalPnl > 0).length,
        traders: sortedByPnl.map(t => ({
            ...t,
            profileUrl: `https://polymarket.com/profile/${t.address}`,
        })),
    };

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(colors.green(`✓ Results saved to: ${filepath}\n`));
}

async function main() {
    console.log(colors.cyan('\n💰 POLYMARKET PROFITABLE TRADER FINDER\n'));
    console.log(colors.gray('Finding traders with positive PnL from the leaderboard...\n'));

    try {
        // Get traders from leaderboard
        const traders = await fetchLeaderboardTraders();

        if (traders.length === 0) {
            console.log(colors.red('No traders found. Exiting.'));
            return;
        }

        console.log(colors.cyan(`🔄 Analyzing ${traders.length} traders...\n`));

        const results: TraderAnalysis[] = [];

        for (let i = 0; i < traders.length; i++) {
            const address = traders[i];
            process.stdout.write(`\r${colors.gray(`  [${i + 1}/${traders.length}] Analyzing ${formatAddress(address)}...`)}`);

            const analysis = await analyzeTrader(address);
            if (analysis) {
                results.push(analysis);

                // Quick status
                const pnlColor = analysis.totalPnl >= 0 ? colors.green : colors.red;
                const pnlSign = analysis.totalPnl >= 0 ? '+' : '';
                process.stdout.write(`\r${colors.gray(`  [${i + 1}/${traders.length}]`)} ${formatAddress(address)} ${pnlColor(`${pnlSign}$${formatNumber(analysis.totalPnl)}`)}                    \n`);
            }

            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log('');

        if (results.length === 0) {
            console.log(colors.red('No traders could be analyzed.'));
            return;
        }

        // Print and save results
        printResults(results);
        saveResults(results);

        console.log(colors.green('✅ Analysis complete!\n'));
    } catch (error) {
        console.error(colors.red('\n✗ Analysis failed:'), error);
        process.exit(1);
    }
}

main();
