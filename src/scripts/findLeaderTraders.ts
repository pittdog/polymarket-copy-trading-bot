import 'dotenv/config';
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
};

interface Market {
    conditionId: string;
    slug: string;
    question: string;
    volume: number;
    liquidity: number;
    active: boolean;
}

interface Trade {
    id: string;
    timestamp: number;
    maker: string;
    taker: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    usdcSize: number;
    market: string;
    asset: string;
    owner: string;
}

interface TraderStats {
    address: string;
    timesFirst: number;
    timesInTopN: number;
    totalVolume: number;
    avgPositionInMarket: number;
    marketsTraded: Set<string>;
    avgTimeToMarket: number; // avg seconds after market opens that they trade
    tradeCount: number;
}

// Configuration
const MIN_MARKET_VOLUME = parseFloat(process.env.LEADER_MIN_VOLUME || '1000');
const MAX_MARKETS = parseInt(process.env.LEADER_MAX_MARKETS || '100');
const TOP_N_THRESHOLD = parseInt(process.env.LEADER_TOP_N || '5'); // Consider top N traders per market
const MIN_FIRST_COUNT = parseInt(process.env.LEADER_MIN_FIRST || '3'); // Min times first to be considered

function formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatNumber(num: number): string {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toFixed(0);
}

async function fetchActiveMarkets(): Promise<Market[]> {
    console.log(colors.cyan('📊 Fetching active markets from Polymarket...\n'));

    try {
        // Fetch events from gamma API (which works)
        const response = await axios.get('https://gamma-api.polymarket.com/events', {
            params: {
                limit: 200,
                active: true,
                closed: false,
            },
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        const markets: Market[] = [];

        // Extract markets from events
        for (const event of response.data) {
            if (!event.markets) continue;

            for (const m of event.markets) {
                if (m.volume >= MIN_MARKET_VOLUME && m.active && !m.closed) {
                    markets.push({
                        conditionId: m.conditionId,
                        slug: m.slug || event.slug || m.question?.slice(0, 50) || 'Unknown',
                        question: m.question || event.title || 'Unknown',
                        volume: parseFloat(m.volume) || 0,
                        liquidity: parseFloat(m.liquidity) || 0,
                        active: m.active,
                    });
                }
            }
        }

        // Sort by volume and limit
        const sortedMarkets = markets
            .sort((a, b) => b.volume - a.volume)
            .slice(0, MAX_MARKETS);

        console.log(colors.green(`✓ Found ${sortedMarkets.length} active markets with volume > $${formatNumber(MIN_MARKET_VOLUME)}\n`));
        return sortedMarkets;
    } catch (error) {
        console.error(colors.red('Failed to fetch markets:'), error);
        return [];
    }
}

async function fetchMarketTrades(conditionId: string): Promise<Trade[]> {
    try {
        const response = await axios.get('https://data-api.polymarket.com/trades', {
            params: {
                market: conditionId,
                limit: 100,
            },
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        return response.data.map((t: any) => ({
            id: t.transactionHash || t.id,
            timestamp: t.timestamp,
            maker: t.maker?.toLowerCase(),
            taker: t.taker?.toLowerCase(),
            side: t.side,
            price: t.price,
            size: t.size,
            usdcSize: t.size * t.price,
            market: conditionId,
            asset: t.asset,
            owner: t.proxyWallet?.toLowerCase(), // Use proxyWallet as the trader
        }));
    } catch (error) {
        return [];
    }
}

async function analyzeMarkets(markets: Market[]): Promise<Map<string, TraderStats>> {
    const traderStats = new Map<string, TraderStats>();
    let processedMarkets = 0;

    for (const market of markets) {
        processedMarkets++;
        process.stdout.write(`\r${colors.gray(`  Analyzing market ${processedMarkets}/${markets.length}: ${market.slug.slice(0, 40)}...`)}`);

        const trades = await fetchMarketTrades(market.conditionId);
        if (trades.length === 0) continue;

        // Sort by timestamp to find first traders
        const sortedTrades = trades.sort((a, b) => a.timestamp - b.timestamp);
        const firstTradeTime = sortedTrades[0]?.timestamp || 0;

        // Track unique traders by their first trade in this market
        const traderFirstTrade = new Map<string, { timestamp: number; volume: number; position: number }>();

        for (const trade of sortedTrades) {
            const trader = trade.owner;
            if (!trader) continue;

            if (!traderFirstTrade.has(trader)) {
                const position = traderFirstTrade.size + 1; // 1-indexed position
                traderFirstTrade.set(trader, {
                    timestamp: trade.timestamp,
                    volume: trade.usdcSize,
                    position,
                });
            } else {
                // Add to their volume
                const existing = traderFirstTrade.get(trader)!;
                existing.volume += trade.usdcSize;
            }
        }

        // Update global stats for each trader
        for (const [trader, data] of traderFirstTrade.entries()) {
            if (!traderStats.has(trader)) {
                traderStats.set(trader, {
                    address: trader,
                    timesFirst: 0,
                    timesInTopN: 0,
                    totalVolume: 0,
                    avgPositionInMarket: 0,
                    marketsTraded: new Set(),
                    avgTimeToMarket: 0,
                    tradeCount: 0,
                });
            }

            const stats = traderStats.get(trader)!;
            stats.marketsTraded.add(market.conditionId);
            stats.totalVolume += data.volume;
            stats.tradeCount++;

            // Track position stats
            const timeToMarket = data.timestamp - firstTradeTime;
            stats.avgTimeToMarket = (stats.avgTimeToMarket * (stats.tradeCount - 1) + timeToMarket) / stats.tradeCount;
            stats.avgPositionInMarket = (stats.avgPositionInMarket * (stats.tradeCount - 1) + data.position) / stats.tradeCount;

            if (data.position === 1) {
                stats.timesFirst++;
            }
            if (data.position <= TOP_N_THRESHOLD) {
                stats.timesInTopN++;
            }
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log('\n');
    return traderStats;
}

function rankTraders(traderStats: Map<string, TraderStats>): TraderStats[] {
    // Filter and sort traders
    const ranked = Array.from(traderStats.values())
        .filter((t) => t.timesFirst >= MIN_FIRST_COUNT || t.timesInTopN >= MIN_FIRST_COUNT * 2)
        .sort((a, b) => {
            // Primary sort: times first
            if (b.timesFirst !== a.timesFirst) return b.timesFirst - a.timesFirst;
            // Secondary: times in top N
            if (b.timesInTopN !== a.timesInTopN) return b.timesInTopN - a.timesInTopN;
            // Tertiary: total volume
            return b.totalVolume - a.totalVolume;
        });

    return ranked;
}

function printResults(ranked: TraderStats[], totalMarkets: number, totalTraders: number) {
    console.log('\n' + colors.cyan('═'.repeat(110)));
    console.log(colors.cyan('  🏆 LEADER TRADERS - WHO TRADES FIRST'));
    console.log(colors.cyan('═'.repeat(110)) + '\n');

    console.log(colors.bold('Configuration:'));
    console.log(`  Markets analyzed: ${totalMarkets} | Min volume: $${formatNumber(MIN_MARKET_VOLUME)} | Top N threshold: ${TOP_N_THRESHOLD}\n`);

    if (ranked.length === 0) {
        console.log(colors.yellow('No traders found matching criteria. Try lowering LEADER_MIN_FIRST.\n'));
        return;
    }

    // Top leaders table
    console.log(colors.bold(colors.green('🥇 TOP LEADER TRADERS (by times trading first):\n')));
    console.log(
        colors.gray(
            '  Rank | Trader                                     | 1st Place | Top 5 | Markets | Avg Pos | Volume     | Avg Delay'
        )
    );
    console.log(colors.gray('  ' + '-'.repeat(105)));

    const displayCount = Math.min(ranked.length, 30);
    for (let i = 0; i < displayCount; i++) {
        const t = ranked[i];
        const rank = String(i + 1).padStart(4);
        const address = t.address.padEnd(42);
        const timesFirst = String(t.timesFirst).padStart(9);
        const timesTopN = String(t.timesInTopN).padStart(5);
        const markets = String(t.marketsTraded.size).padStart(7);
        const avgPos = t.avgPositionInMarket.toFixed(1).padStart(7);
        const volume = ('$' + formatNumber(t.totalVolume)).padStart(10);
        const avgDelay = t.avgTimeToMarket < 60
            ? `${t.avgTimeToMarket.toFixed(0)}s`.padStart(9)
            : `${(t.avgTimeToMarket / 60).toFixed(1)}m`.padStart(9);

        const color = i < 3 ? colors.green : i < 10 ? colors.yellow : colors.blue;
        console.log(
            `  ${color(rank)} | ${colors.blue(formatAddress(t.address))} ${colors.gray(t.address.slice(6, -4))} | ${colors.green(timesFirst)} | ${timesTopN} | ${markets} | ${avgPos} | ${volume} | ${avgDelay}`
        );
    }

    if (ranked.length > displayCount) {
        console.log(colors.gray(`\n  ... and ${ranked.length - displayCount} more traders\n`));
    }

    // Summary
    console.log('\n' + colors.cyan('═'.repeat(110)));
    console.log(colors.bold('\n📊 SUMMARY:\n'));

    const top10 = ranked.slice(0, 10);
    const avgFirstRate = top10.reduce((sum, t) => sum + (t.timesFirst / t.marketsTraded.size), 0) / top10.length;
    const avgVolume = top10.reduce((sum, t) => sum + t.totalVolume, 0) / top10.length;

    console.log(`  Total unique traders found: ${totalTraders}`);
    console.log(`  Traders meeting criteria: ${ranked.length}`);
    console.log(`  Top 10 avg "first" rate: ${(avgFirstRate * 100).toFixed(1)}% of their markets`);
    console.log(`  Top 10 avg volume: $${formatNumber(avgVolume)}`);

    // Recommendations
    console.log(colors.bold(colors.magenta('\n💡 RECOMMENDED TRADERS TO FOLLOW:\n')));

    const recommended = ranked.slice(0, 5);
    for (const t of recommended) {
        const firstRate = ((t.timesFirst / t.marketsTraded.size) * 100).toFixed(0);
        console.log(`  ${colors.green('→')} ${colors.blue(t.address)}`);
        console.log(`    First ${t.timesFirst}x across ${t.marketsTraded.size} markets (${firstRate}% first rate)`);
        console.log(`    Profile: https://polymarket.com/profile/${t.address}`);
        console.log('');
    }

    console.log(colors.cyan('═'.repeat(110)) + '\n');
}

function saveResults(ranked: TraderStats[], totalMarkets: number) {
    const resultsDir = path.join(process.cwd(), 'leader_trader_results');
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `leaders_${timestamp}.json`;
    const filepath = path.join(resultsDir, filename);

    const data = {
        config: {
            minMarketVolume: MIN_MARKET_VOLUME,
            maxMarkets: MAX_MARKETS,
            topNThreshold: TOP_N_THRESHOLD,
            minFirstCount: MIN_FIRST_COUNT,
        },
        timestamp: Date.now(),
        totalMarketsAnalyzed: totalMarkets,
        totalTradersFound: ranked.length,
        traders: ranked.slice(0, 100).map((t) => ({
            address: t.address,
            profileUrl: `https://polymarket.com/profile/${t.address}`,
            timesFirst: t.timesFirst,
            timesInTopN: t.timesInTopN,
            marketsTraded: t.marketsTraded.size,
            totalVolume: t.totalVolume,
            avgPositionInMarket: t.avgPositionInMarket,
            avgTimeToMarketSeconds: t.avgTimeToMarket,
            firstRate: t.timesFirst / t.marketsTraded.size,
        })),
    };

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(colors.green(`✓ Results saved to: ${filepath}\n`));
}

async function main() {
    console.log(colors.cyan('\n🔍 POLYMARKET LEADER TRADER FINDER\n'));
    console.log(colors.gray('Scanning markets to find traders who consistently trade first\n'));

    console.log(colors.bold('Settings:'));
    console.log(`  Min market volume: $${formatNumber(MIN_MARKET_VOLUME)}`);
    console.log(`  Max markets to scan: ${MAX_MARKETS}`);
    console.log(`  Top N threshold: ${TOP_N_THRESHOLD}`);
    console.log(`  Min times first: ${MIN_FIRST_COUNT}\n`);

    try {
        // Fetch active markets
        const markets = await fetchActiveMarkets();
        if (markets.length === 0) {
            console.log(colors.red('No markets found. Try lowering LEADER_MIN_VOLUME.'));
            process.exit(1);
        }

        // Analyze each market
        console.log(colors.cyan('🔄 Analyzing market trades...\n'));
        const traderStats = await analyzeMarkets(markets);

        console.log(colors.green(`✓ Analyzed ${markets.length} markets, found ${traderStats.size} unique traders\n`));

        // Rank traders
        const ranked = rankTraders(traderStats);

        // Print and save results
        printResults(ranked, markets.length, traderStats.size);
        saveResults(ranked, markets.length);

        console.log(colors.green('✅ Analysis complete!\n'));
    } catch (error) {
        console.error(colors.red('\n✗ Analysis failed:'), error);
        process.exit(1);
    }
}

main();
