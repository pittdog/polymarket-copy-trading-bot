import 'dotenv/config';
import axios from 'axios';

const colors = {
    cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
    green: (text: string) => `\x1b[32m${text}\x1b[0m`,
    red: (text: string) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
    blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
    gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

interface Trade {
    id: string;
    timestamp: number;
    proxyWallet: string;
    side: string;
    price: number;
    size: number;
    usdcSize: number;
}

interface MarketInfo {
    conditionId: string;
    question: string;
    slug: string;
}

function formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTime(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

async function findMarketBySlug(slug: string): Promise<MarketInfo | null> {
    try {
        const response = await axios.get(`https://gamma-api.polymarket.com/markets`, {
            params: { slug },
            timeout: 15000,
        });

        if (response.data && response.data.length > 0) {
            const m = response.data[0];
            return {
                conditionId: m.conditionId,
                question: m.question,
                slug: m.slug,
            };
        }
        return null;
    } catch {
        return null;
    }
}

async function findMarketByConditionId(conditionId: string): Promise<MarketInfo | null> {
    try {
        const response = await axios.get(`https://gamma-api.polymarket.com/markets`, {
            params: { conditionId },
            timeout: 15000,
        });

        if (response.data && response.data.length > 0) {
            const m = response.data[0];
            return {
                conditionId: m.conditionId,
                question: m.question,
                slug: m.slug,
            };
        }
        return null;
    } catch {
        return null;
    }
}

async function fetchMarketTrades(conditionId: string, limit: number = 500): Promise<Trade[]> {
    try {
        const response = await axios.get('https://data-api.polymarket.com/trades', {
            params: {
                market: conditionId,
                limit,
            },
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        return response.data.map((t: any) => ({
            id: t.transactionHash || t.id,
            timestamp: t.timestamp,
            proxyWallet: t.proxyWallet?.toLowerCase(),
            side: t.side,
            price: t.price,
            size: t.size,
            usdcSize: t.size * t.price,
        }));
    } catch (error) {
        console.error(colors.red('Failed to fetch trades:'), error);
        return [];
    }
}

async function main() {
    const input = process.argv[2] || process.env.MARKET_ID;

    if (!input) {
        console.log(colors.red('\n✗ Please provide a market conditionId or slug\n'));
        console.log('Usage:');
        console.log('  npm run find-first <conditionId>');
        console.log('  npm run find-first <slug>');
        console.log('  MARKET_ID=<conditionId> npm run find-first\n');
        console.log('Example:');
        console.log('  npm run find-first 0x1234...abcd');
        console.log('  npm run find-first will-trump-win-2024\n');
        process.exit(1);
    }

    console.log(colors.cyan('\n🔍 FIND FIRST TRADER IN MARKET\n'));

    // Try to find market info
    let market: MarketInfo | null = null;

    if (input.startsWith('0x')) {
        console.log(colors.gray(`Looking up market by conditionId: ${input}...`));
        market = await findMarketByConditionId(input);
    } else {
        console.log(colors.gray(`Looking up market by slug: ${input}...`));
        market = await findMarketBySlug(input);
    }

    const conditionId = market?.conditionId || input;

    if (market) {
        console.log(colors.green(`\n✓ Found market: ${market.question}\n`));
    } else {
        console.log(colors.yellow(`\n⚠ Could not find market info, using input as conditionId\n`));
    }

    // Fetch trades
    console.log(colors.gray('Fetching trades...'));
    const trades = await fetchMarketTrades(conditionId);

    if (trades.length === 0) {
        console.log(colors.red('\n✗ No trades found for this market\n'));
        process.exit(1);
    }

    // Sort by timestamp (earliest first)
    const sortedTrades = trades.sort((a, b) => a.timestamp - b.timestamp);

    // Get unique traders in order of first appearance
    const traderOrder = new Map<string, { firstTrade: Trade; totalVolume: number; tradeCount: number }>();

    for (const trade of sortedTrades) {
        if (!trade.proxyWallet) continue;

        if (!traderOrder.has(trade.proxyWallet)) {
            traderOrder.set(trade.proxyWallet, {
                firstTrade: trade,
                totalVolume: trade.usdcSize,
                tradeCount: 1,
            });
        } else {
            const data = traderOrder.get(trade.proxyWallet)!;
            data.totalVolume += trade.usdcSize;
            data.tradeCount++;
        }
    }

    const firstTradeTime = sortedTrades[0]?.timestamp || 0;

    // Display results
    console.log('\n' + colors.cyan('═'.repeat(100)));
    console.log(colors.cyan('  🏆 FIRST TRADERS IN MARKET'));
    console.log(colors.cyan('═'.repeat(100)) + '\n');

    if (market) {
        console.log(colors.bold(`Market: ${market.question}`));
        console.log(colors.gray(`Slug: ${market.slug}`));
        console.log(colors.gray(`ConditionId: ${conditionId}\n`));
    }

    console.log(colors.bold(`Total trades: ${trades.length} | Unique traders: ${traderOrder.size}\n`));

    console.log(colors.gray('  Pos | Trader                                     | First Trade Time         | Delay      | Side | Price  | Volume   | Total Vol'));
    console.log(colors.gray('  ' + '-'.repeat(95)));

    let position = 0;
    for (const [address, data] of traderOrder.entries()) {
        position++;
        if (position > 20) break; // Show top 20

        const delay = data.firstTrade.timestamp - firstTradeTime;
        const delayStr = delay === 0 ? '0s (FIRST)' :
            delay < 60 ? `${delay}s` :
            delay < 3600 ? `${(delay / 60).toFixed(1)}m` :
            `${(delay / 3600).toFixed(1)}h`;

        const posStr = String(position).padStart(4);
        const addrStr = address.padEnd(42);
        const timeStr = formatTime(data.firstTrade.timestamp);
        const delayPad = delayStr.padStart(10);
        const side = data.firstTrade.side.padEnd(4);
        const price = data.firstTrade.price.toFixed(2).padStart(6);
        const vol = `$${data.firstTrade.usdcSize.toFixed(0)}`.padStart(8);
        const totalVol = `$${data.totalVolume.toFixed(0)}`.padStart(9);

        const color = position === 1 ? colors.green : position <= 3 ? colors.yellow : colors.blue;

        console.log(
            `  ${color(posStr)} | ${colors.blue(formatAddress(address))} ${colors.gray(address.slice(6, -4))} | ${timeStr} | ${position === 1 ? colors.green(delayPad) : delayPad} | ${side} | ${price} | ${vol} | ${totalVol}`
        );
    }

    // Show the winner
    const winner = Array.from(traderOrder.entries())[0];
    if (winner) {
        console.log('\n' + colors.cyan('═'.repeat(100)));
        console.log(colors.bold(colors.green('\n🥇 FIRST TRADER:\n')));
        console.log(`  Address: ${colors.blue(winner[0])}`);
        console.log(`  Profile: https://polymarket.com/profile/${winner[0]}`);
        console.log(`  First trade: ${formatTime(winner[1].firstTrade.timestamp)}`);
        console.log(`  Side: ${winner[1].firstTrade.side} @ $${winner[1].firstTrade.price.toFixed(2)}`);
        console.log(`  Total volume in market: $${winner[1].totalVolume.toFixed(2)}`);
        console.log(`  Trade count: ${winner[1].tradeCount}`);
    }

    console.log('\n' + colors.cyan('═'.repeat(100)) + '\n');
}

main();
