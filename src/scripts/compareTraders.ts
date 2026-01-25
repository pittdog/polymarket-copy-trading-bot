import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// Colors for console output
const colors = {
    cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
    green: (text: string) => `\x1b[32m${text}\x1b[0m`,
    red: (text: string) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
    blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
    gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
    magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
    white: (text: string) => `\x1b[37m${text}\x1b[0m`,
};

interface Trade {
    id: string;
    timestamp: number;
    market: string;
    conditionId: string;
    asset: string;
    side: 'BUY' | 'SELL';
    price: number;
    usdcSize: number;
    size: number;
    outcome: string;
    transactionHash?: string;
}

interface TraderTrades {
    address: string;
    trades: Trade[];
}

interface MatchedTrade {
    conditionId: string;
    market: string;
    outcome: string;
    traderTrades: {
        address: string;
        trade: Trade;
        timestamp: number;
        side: 'BUY' | 'SELL';
        price: number;
        usdcSize: number;
    }[];
    timeDiffs: {
        trader1: string;
        trader2: string;
        diffSeconds: number;
        leader: string;
    }[];
}

interface ComparisonSummary {
    trader: string;
    totalTrades: number;
    matchedTrades: number;
    timesFirst: number;
    avgLeadTimeSeconds: number;
    avgFollowTimeSeconds: number;
}

// Configuration
const HISTORY_DAYS = parseInt(process.env.COMPARE_HISTORY_DAYS || '30');
const MAX_TRADES_LIMIT = parseInt(process.env.COMPARE_MAX_TRADES || '1000');
const TIME_WINDOW_HOURS = parseInt(process.env.COMPARE_TIME_WINDOW_HOURS || '24');

function formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimestamp(ts: number): string {
    return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function formatTimeDiff(seconds: number): string {
    const abs = Math.abs(seconds);
    if (abs < 60) return `${abs.toFixed(0)}s`;
    if (abs < 3600) return `${(abs / 60).toFixed(1)}m`;
    if (abs < 86400) return `${(abs / 3600).toFixed(1)}h`;
    return `${(abs / 86400).toFixed(1)}d`;
}

async function fetchBatch(
    traderAddress: string,
    offset: number,
    limit: number,
    sinceTimestamp: number
): Promise<Trade[]> {
    try {
        const response = await axios.get(
            `https://data-api.polymarket.com/activity?user=${traderAddress}&type=TRADE&limit=${limit}&offset=${offset}`,
            {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            }
        );

        const trades: Trade[] = response.data.map((item: any) => ({
            id: item.id,
            timestamp: item.timestamp,
            market: item.slug || item.title || item.market || 'Unknown',
            conditionId: item.conditionId,
            asset: item.asset,
            side: item.side,
            price: item.price,
            usdcSize: item.usdcSize,
            size: item.size,
            outcome: item.outcome || 'Unknown',
            transactionHash: item.transactionHash,
        }));

        return trades.filter((t) => t.timestamp >= sinceTimestamp);
    } catch (error) {
        return [];
    }
}

async function fetchTraderActivity(traderAddress: string): Promise<Trade[]> {
    const sinceTimestamp = Math.floor((Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000) / 1000);

    console.log(colors.gray(`  Fetching trades for ${formatAddress(traderAddress)}...`));

    const firstBatch = await fetchBatch(traderAddress, 0, 100, sinceTimestamp);
    let allTrades: Trade[] = [...firstBatch];

    if (firstBatch.length === 100) {
        const batchSize = 100;
        const maxParallel = 3;
        let offset = 100;
        let hasMore = true;

        while (hasMore && allTrades.length < MAX_TRADES_LIMIT) {
            const promises: Promise<Trade[]>[] = [];
            for (let i = 0; i < maxParallel; i++) {
                promises.push(
                    fetchBatch(traderAddress, offset + i * batchSize, batchSize, sinceTimestamp)
                );
            }

            const results = await Promise.all(promises);
            let addedCount = 0;

            for (const batch of results) {
                if (batch.length > 0) {
                    allTrades = allTrades.concat(batch);
                    addedCount += batch.length;
                }
                if (batch.length < batchSize) {
                    hasMore = false;
                    break;
                }
            }

            if (addedCount === 0) hasMore = false;
            if (allTrades.length >= MAX_TRADES_LIMIT) {
                allTrades = allTrades.slice(0, MAX_TRADES_LIMIT);
                hasMore = false;
            }

            offset += maxParallel * batchSize;
        }
    }

    console.log(colors.green(`  ✓ Found ${allTrades.length} trades`));
    return allTrades.sort((a, b) => a.timestamp - b.timestamp);
}

function findMatchingTrades(traderData: TraderTrades[]): MatchedTrade[] {
    // Group all trades by conditionId
    const tradesByCondition = new Map<string, Map<string, Trade[]>>();

    for (const trader of traderData) {
        for (const trade of trader.trades) {
            if (!tradesByCondition.has(trade.conditionId)) {
                tradesByCondition.set(trade.conditionId, new Map());
            }
            const conditionMap = tradesByCondition.get(trade.conditionId)!;
            if (!conditionMap.has(trader.address)) {
                conditionMap.set(trader.address, []);
            }
            conditionMap.get(trader.address)!.push(trade);
        }
    }

    const matched: MatchedTrade[] = [];
    const timeWindowSeconds = TIME_WINDOW_HOURS * 3600;

    // Find conditions where multiple traders participated
    for (const [conditionId, traderMap] of tradesByCondition.entries()) {
        if (traderMap.size < 2) continue; // Need at least 2 traders

        const tradersInvolved = Array.from(traderMap.keys());
        const firstTrade = traderMap.get(tradersInvolved[0])![0];

        // For each combination of traders, find matching trades within time window
        const allTraderTrades: MatchedTrade['traderTrades'] = [];
        const timeDiffs: MatchedTrade['timeDiffs'] = [];

        for (const [address, trades] of traderMap.entries()) {
            // Get the first trade for this condition from this trader
            const firstTradeForCondition = trades.sort((a, b) => a.timestamp - b.timestamp)[0];
            allTraderTrades.push({
                address,
                trade: firstTradeForCondition,
                timestamp: firstTradeForCondition.timestamp,
                side: firstTradeForCondition.side,
                price: firstTradeForCondition.price,
                usdcSize: firstTradeForCondition.usdcSize,
            });
        }

        // Calculate time differences between all pairs
        for (let i = 0; i < allTraderTrades.length; i++) {
            for (let j = i + 1; j < allTraderTrades.length; j++) {
                const t1 = allTraderTrades[i];
                const t2 = allTraderTrades[j];
                const diff = t2.timestamp - t1.timestamp;

                // Only include if within time window
                if (Math.abs(diff) <= timeWindowSeconds) {
                    timeDiffs.push({
                        trader1: t1.address,
                        trader2: t2.address,
                        diffSeconds: diff,
                        leader: diff <= 0 ? t2.address : t1.address,
                    });
                }
            }
        }

        if (timeDiffs.length > 0) {
            matched.push({
                conditionId,
                market: firstTrade.market,
                outcome: firstTrade.outcome,
                traderTrades: allTraderTrades,
                timeDiffs,
            });
        }
    }

    return matched.sort((a, b) => {
        const aTime = Math.min(...a.traderTrades.map((t) => t.timestamp));
        const bTime = Math.min(...b.traderTrades.map((t) => t.timestamp));
        return bTime - aTime; // Most recent first
    });
}

function calculateSummaries(
    matched: MatchedTrade[],
    traderData: TraderTrades[]
): ComparisonSummary[] {
    const summaries: ComparisonSummary[] = [];

    for (const trader of traderData) {
        let timesFirst = 0;
        let totalLeadTime = 0;
        let leadCount = 0;
        let totalFollowTime = 0;
        let followCount = 0;
        let matchedTradeCount = 0;

        for (const match of matched) {
            const traderInMatch = match.traderTrades.find((t) => t.address === trader.address);
            if (!traderInMatch) continue;

            matchedTradeCount++;

            for (const diff of match.timeDiffs) {
                if (diff.trader1 !== trader.address && diff.trader2 !== trader.address) continue;

                if (diff.leader === trader.address) {
                    timesFirst++;
                    // Calculate how far ahead this trader was
                    const leadTime = Math.abs(diff.diffSeconds);
                    totalLeadTime += leadTime;
                    leadCount++;
                } else {
                    // This trader followed
                    const followTime = Math.abs(diff.diffSeconds);
                    totalFollowTime += followTime;
                    followCount++;
                }
            }
        }

        summaries.push({
            trader: trader.address,
            totalTrades: trader.trades.length,
            matchedTrades: matchedTradeCount,
            timesFirst,
            avgLeadTimeSeconds: leadCount > 0 ? totalLeadTime / leadCount : 0,
            avgFollowTimeSeconds: followCount > 0 ? totalFollowTime / followCount : 0,
        });
    }

    return summaries.sort((a, b) => b.timesFirst - a.timesFirst);
}

function printResults(
    matched: MatchedTrade[],
    summaries: ComparisonSummary[],
    traderData: TraderTrades[]
) {
    console.log('\n' + colors.cyan('═'.repeat(100)));
    console.log(colors.cyan('  📊 TRADER COMPARISON RESULTS'));
    console.log(colors.cyan('═'.repeat(100)) + '\n');

    console.log(colors.bold('Configuration:'));
    console.log(
        `  History: ${HISTORY_DAYS} days | Time window: ${TIME_WINDOW_HOURS}h | Traders: ${traderData.length}\n`
    );

    // Summary table
    console.log(colors.bold(colors.green('🏆 TRADER LEADERSHIP SUMMARY:\n')));
    console.log(
        colors.gray(
            '  Trader                  | Total Trades | Matched | Times First | Avg Lead Time | Avg Follow Time'
        )
    );
    console.log(colors.gray('  ' + '-'.repeat(95)));

    for (const summary of summaries) {
        const firstPct =
            summary.matchedTrades > 0
                ? ((summary.timesFirst / summary.matchedTrades) * 100).toFixed(0)
                : '0';
        console.log(
            `  ${colors.blue(formatAddress(summary.trader).padEnd(22))} | ` +
                `${String(summary.totalTrades).padStart(12)} | ` +
                `${String(summary.matchedTrades).padStart(7)} | ` +
                `${colors.green(String(summary.timesFirst).padStart(11))} | ` +
                `${formatTimeDiff(summary.avgLeadTimeSeconds).padStart(13)} | ` +
                `${formatTimeDiff(summary.avgFollowTimeSeconds).padStart(15)}`
        );
    }

    // Detailed matched trades
    console.log('\n' + colors.bold(colors.yellow(`\n📋 MATCHED TRADES (${matched.length} markets):\n`)));

    const displayCount = Math.min(matched.length, 20);
    for (let i = 0; i < displayCount; i++) {
        const match = matched[i];
        console.log(colors.bold(`${i + 1}. ${match.market}`));
        console.log(colors.gray(`   Condition: ${match.conditionId.slice(0, 20)}...`));

        // Sort trades by timestamp
        const sortedTrades = [...match.traderTrades].sort((a, b) => a.timestamp - b.timestamp);

        for (let j = 0; j < sortedTrades.length; j++) {
            const t = sortedTrades[j];
            const isFirst = j === 0;
            const marker = isFirst ? colors.green('→ FIRST') : colors.yellow('  FOLLOW');
            const timeSinceFirst =
                j > 0 ? colors.gray(`(+${formatTimeDiff(t.timestamp - sortedTrades[0].timestamp)})`) : '';

            console.log(
                `   ${marker} ${colors.blue(formatAddress(t.address))} | ` +
                    `${t.side === 'BUY' ? colors.green('BUY ') : colors.red('SELL')} | ` +
                    `$${t.usdcSize.toFixed(2).padStart(8)} @ $${t.price.toFixed(3)} | ` +
                    `${formatTimestamp(t.timestamp)} ${timeSinceFirst}`
            );
        }
        console.log('');
    }

    if (matched.length > displayCount) {
        console.log(colors.gray(`   ... and ${matched.length - displayCount} more matched markets\n`));
    }

    // Time difference analysis
    console.log(colors.bold(colors.magenta('\n⏱️  TIME DIFFERENCE ANALYSIS:\n')));

    const allDiffs: { diff: number; market: string }[] = [];
    for (const match of matched) {
        for (const diff of match.timeDiffs) {
            allDiffs.push({ diff: Math.abs(diff.diffSeconds), market: match.market });
        }
    }

    if (allDiffs.length > 0) {
        allDiffs.sort((a, b) => a.diff - b.diff);
        const median = allDiffs[Math.floor(allDiffs.length / 2)].diff;
        const avg = allDiffs.reduce((sum, d) => sum + d.diff, 0) / allDiffs.length;
        const min = allDiffs[0].diff;
        const max = allDiffs[allDiffs.length - 1].diff;

        console.log(`  Total comparisons: ${allDiffs.length}`);
        console.log(`  Minimum gap: ${formatTimeDiff(min)}`);
        console.log(`  Maximum gap: ${formatTimeDiff(max)}`);
        console.log(`  Median gap: ${formatTimeDiff(median)}`);
        console.log(`  Average gap: ${formatTimeDiff(avg)}`);

        // Distribution
        const under1min = allDiffs.filter((d) => d.diff < 60).length;
        const under5min = allDiffs.filter((d) => d.diff < 300).length;
        const under1hour = allDiffs.filter((d) => d.diff < 3600).length;

        console.log('\n  Distribution:');
        console.log(`    < 1 minute:  ${under1min} (${((under1min / allDiffs.length) * 100).toFixed(1)}%)`);
        console.log(`    < 5 minutes: ${under5min} (${((under5min / allDiffs.length) * 100).toFixed(1)}%)`);
        console.log(`    < 1 hour:    ${under1hour} (${((under1hour / allDiffs.length) * 100).toFixed(1)}%)`);
    }

    console.log('\n' + colors.cyan('═'.repeat(100)) + '\n');
}

function saveResults(
    matched: MatchedTrade[],
    summaries: ComparisonSummary[],
    traderData: TraderTrades[]
) {
    const resultsDir = path.join(process.cwd(), 'trader_comparison_results');
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `comparison_${HISTORY_DAYS}d_${timestamp}.json`;
    const filepath = path.join(resultsDir, filename);

    const data = {
        config: {
            historyDays: HISTORY_DAYS,
            timeWindowHours: TIME_WINDOW_HOURS,
            traders: traderData.map((t) => t.address),
        },
        timestamp: Date.now(),
        summaries,
        matchedTrades: matched.map((m) => ({
            ...m,
            polymarketUrl: `https://polymarket.com/event/${m.conditionId}`,
        })),
    };

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(colors.green(`✓ Results saved to: ${filepath}\n`));
}

async function main() {
    console.log(colors.cyan('\n🔍 POLYMARKET TRADER COMPARISON TOOL\n'));
    console.log(colors.gray('Compare trading timing between multiple traders\n'));

    // Get trader addresses from args or env
    let traders: string[] = [];

    // Check command line args first
    const args = process.argv.slice(2);
    if (args.length >= 2) {
        traders = args.map((t) => t.trim().toLowerCase());
    } else if (process.env.COMPARE_TRADERS) {
        traders = process.env.COMPARE_TRADERS.split(',').map((t) => t.trim().toLowerCase());
    }

    if (traders.length < 2) {
        console.log(colors.red('❌ Please provide at least 2 trader addresses\n'));
        console.log('Usage:');
        console.log('  npm run compare-traders <address1> <address2> [address3] ...');
        console.log('  OR set COMPARE_TRADERS env variable with comma-separated addresses\n');
        console.log('Environment variables:');
        console.log('  COMPARE_TRADERS - Comma-separated trader addresses');
        console.log('  COMPARE_HISTORY_DAYS - Days of history to analyze (default: 30)');
        console.log('  COMPARE_TIME_WINDOW_HOURS - Max time gap to consider same trade (default: 24)');
        console.log('  COMPARE_MAX_TRADES - Max trades to fetch per trader (default: 1000)\n');
        process.exit(1);
    }

    console.log(colors.cyan(`Comparing ${traders.length} traders:\n`));
    traders.forEach((t, i) => {
        console.log(`  ${i + 1}. ${colors.blue(t)}`);
        console.log(colors.gray(`     https://polymarket.com/profile/${t}`));
    });
    console.log('');

    try {
        // Fetch all trader data
        console.log(colors.cyan('\n📥 Fetching trade history...\n'));
        const traderData: TraderTrades[] = [];

        for (const address of traders) {
            const trades = await fetchTraderActivity(address);
            traderData.push({ address, trades });
            // Small delay to avoid rate limiting
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        // Find matching trades
        console.log(colors.cyan('\n🔄 Analyzing matching trades...\n'));
        const matched = findMatchingTrades(traderData);
        console.log(colors.green(`✓ Found ${matched.length} markets where multiple traders participated\n`));

        // Calculate summaries
        const summaries = calculateSummaries(matched, traderData);

        // Print and save results
        printResults(matched, summaries, traderData);
        saveResults(matched, summaries, traderData);

        console.log(colors.green('✅ Comparison complete!\n'));
    } catch (error) {
        console.error(colors.red('\n✗ Comparison failed:'), error);
        process.exit(1);
    }
}

main();
