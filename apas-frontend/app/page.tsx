import Link from "next/link";
import { Shield, Zap, Coins, Layers, ArrowRight, CheckCircle, TrendingUp, Wallet, DollarSign, Users, Info, Send, UserCheck, History, Ghost, Target } from "lucide-react";

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* ── Navigation ── */}
      <nav className="w-full px-6 py-4 flex items-center justify-between border-b border-gray-700/50 backdrop-blur-sm bg-gray-900/80 sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-blue-400" />
          <span className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            CipherNet
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {/* ── How It Works button (responsive) ── */}
          <Link
            href="/how-it-works"
            className="inline-flex items-center gap-1 sm:gap-2 px-3 sm:px-5 py-1.5 sm:py-2.5 border border-blue-500/40 rounded-lg sm:rounded-xl text-xs sm:text-sm font-medium text-blue-400 hover:bg-blue-500/20 hover:border-blue-400 hover:text-blue-300 transition-all duration-200 shadow-[0_0_15px_rgba(59,130,246,0.15)]"
          >
            <Info className="w-3 h-3 sm:w-4 sm:h-4" />
            <span className="inline">How It Works</span>
          </Link>

          <Link href="/login" className="text-sm text-gray-300 hover:text-white transition-colors hidden sm:inline">
            Log In
          </Link>
          <Link
            href="/register"
            className="text-sm px-3 sm:px-4 py-1.5 sm:py-2 bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/25"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-12 md:py-20">
        <div className="flex flex-col lg:flex-row items-center gap-12">
          <div className="flex-1 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-500/10 to-purple-500/10 text-blue-400 border border-blue-500/30 rounded-full px-4 py-1.5 text-sm font-medium mb-6">
              <Zap className="w-4 h-4" />
              <span>V3.1 – Mirror Token Exploit</span>
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-tight">
              Deploy <span className="bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">Zero-Cost Poison</span> at Scale
            </h1>
            <p className="mt-4 text-lg text-gray-400 max-w-xl mx-auto lg:mx-0">
              Automatically generate vanity addresses, exploit explorer indexing with forged events, and sweep funds — all from a single dashboard.
            </p>
            <div className="mt-4 bg-gray-800/40 border border-gray-700/50 rounded-xl p-4 max-w-xl mx-auto lg:mx-0">
              <p className="text-sm text-gray-300 flex items-start gap-2">
                <Ghost className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" />
                <span>
                  <span className="font-semibold text-white">V3.1 Zero-Cost Poisoning:</span>{" "}
                  Forges exact Transfer events in victim history without spending real tokens. Only requires gas.
                </span>
              </p>
            </div>
            <div className="mt-8 flex flex-col sm:flex-row items-center gap-4">
              <Link
                href="/register"
                className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/25 text-sm font-medium"
              >
                Get Started <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/login"
                className="px-6 py-3 border border-gray-600 rounded-xl hover:border-gray-400 transition-colors text-sm text-gray-300 hover:text-white"
              >
                Log In →
              </Link>
            </div>
          </div>
          <div className="flex-1 flex justify-center">
            <div className="w-full max-w-md aspect-square rounded-3xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/20 backdrop-blur-sm p-8 flex items-center justify-center">
              <div className="text-center">
                <Shield className="w-24 h-24 text-blue-400 mx-auto mb-4" />
                <p className="text-gray-300 text-sm font-mono">0x7f…3a9b</p>
                <p className="text-green-400 text-sm mt-2">● Active Traps: 12</p>
                <p className="text-gray-400 text-xs mt-1">1.2 ETH swept (24h)</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ── What's New in V3.1 ── */}
      <section className="max-w-6xl mx-auto w-full px-6 py-12 border-t border-gray-800/50">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-500/10 to-pink-500/10 text-purple-400 border border-purple-500/30 rounded-full px-4 py-1.5 text-sm font-medium mb-4">
            <Zap className="w-4 h-4" />
            <span>What's New in V3.1</span>
          </div>
          <h2 className="text-2xl md:text-3xl font-bold text-white">
            Mirror Token Exploit & Zero-Cost Poisoning
          </h2>
          <p className="text-gray-400 mt-2 max-w-2xl mx-auto">
            Emit forged Transfer events directly to the blockchain. Etherscan and wallets index them as real history — without spending a single token.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 backdrop-blur-sm border border-blue-500/20 rounded-2xl p-6 hover:border-blue-500/40 transition-all">
            <div className="w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center mb-4">
              <History className="w-6 h-6 text-blue-400" />
            </div>
            <h3 className="text-white font-semibold text-lg mb-2">Perfect History Match</h3>
            <p className="text-gray-400 text-sm">
              Fetches the exact amount and asset (USDT, USDC, ETH) the victim last sent to the counterparty, and mirrors it perfectly in their transaction history.
            </p>
          </div>

          <div className="bg-gradient-to-br from-purple-500/10 to-purple-600/5 backdrop-blur-sm border border-purple-500/20 rounded-2xl p-6 hover:border-purple-500/40 transition-all">
            <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center mb-4">
              <Ghost className="w-6 h-6 text-purple-400" />
            </div>
            <h3 className="text-white font-semibold text-lg mb-2">Zero Token Balance</h3>
            <p className="text-gray-400 text-sm">
              Trap wallets don't need to hold USDT, USDC, or ETH. Only the campaign funding wallet pays a tiny gas fee (~$0.50) to emit the forged event.
            </p>
          </div>

          <div className="bg-gradient-to-br from-green-500/10 to-green-600/5 backdrop-blur-sm border border-green-500/20 rounded-2xl p-6 hover:border-green-500/40 transition-all">
            <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center mb-4">
              <Target className="w-6 h-6 text-green-400" />
            </div>
            <h3 className="text-white font-semibold text-lg mb-2">Explorer UI Exploitation</h3>
            <p className="text-gray-400 text-sm">
              Exploits how Etherscan, MetaMask, and wallets index Transfer events. Victims see the trap in their history and copy-paste it for their next transfer.
            </p>
          </div>
        </div>

        <div className="mt-8 bg-gray-800/30 border border-gray-700/50 rounded-2xl p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <h4 className="text-white font-semibold mb-3 flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-400" />
                Stage 1: Human Targeting
              </h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li className="flex items-start gap-2">
                  <span className="text-green-400 mt-1">✓</span>
                  <span>Filters out bots, MEV, and smart contracts</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-400 mt-1">✓</span>
                  <span>High-nonce and balance threshold checks</span>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-3 flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-blue-400" />
                Stage 2: Mirror Emission
              </h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 mt-1">✓</span>
                  <span>Alchemy RPC fetches last victim→counterparty transfer</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-blue-400 mt-1">✓</span>
                  <span>Emits forged Transfer event via MirrorToken contract</span>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-3 flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-purple-400" />
                Stage 3: Auto-Sweeping
              </h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li className="flex items-start gap-2">
                  <span className="text-purple-400 mt-1">✓</span>
                  <span>Victim copy-pastes trap from their history</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-purple-400 mt-1">✓</span>
                  <span>Funds auto-swept to your safe wallet</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Partnership / Pricing ── */}
      <section className="max-w-6xl mx-auto w-full px-6 py-12 border-t border-gray-800/50">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center mx-auto mb-4">
              <DollarSign className="w-6 h-6 text-green-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">60% / 40% Profit Split</h3>
            <p className="text-gray-400 text-sm mt-2">
              You keep <span className="text-green-400 font-medium">60%</span> of all swept funds. The remaining <span className="text-purple-400 font-medium">40%</span> powers the platform.
            </p>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center mx-auto mb-4">
              <Users className="w-6 h-6 text-blue-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">$500 One‑Time Setup</h3>
            <p className="text-gray-400 text-sm mt-2">
              Pay once to activate your account and gain full access to the entire ecosystem — no monthly fees.
            </p>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="max-w-6xl mx-auto w-full px-6 py-16 border-t border-gray-800/50">
        <h2 className="text-3xl md:text-4xl font-bold text-center">
          Everything You Need for <span className="text-blue-400">Next‑Gen Trapping</span>
        </h2>
        <p className="text-center text-gray-400 mt-2 max-w-2xl mx-auto">
          From vanity generation to automated sweeping — all in one platform.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-12">
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 hover:border-blue-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center mb-4">
              <Layers className="w-6 h-6 text-blue-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">Vanity Generation</h3>
            <p className="text-gray-400 text-sm mt-2">
              Generate custom vanity addresses matching any counterparty prefix/suffix using Clore.ai GPU power.
            </p>
          </div>

          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 hover:border-green-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center mb-4">
              <Ghost className="w-6 h-6 text-green-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">Mirror Token Exploit</h3>
            <p className="text-gray-400 text-sm mt-2">
              Emit forged Transfer events directly to the blockchain. Victims see the exact amount they sent to the counterparty mirrored in their history.
            </p>
          </div>

          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 hover:border-blue-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center mb-4">
              <UserCheck className="w-6 h-6 text-green-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">Human-Only Filtering</h3>
            <p className="text-gray-400 text-sm mt-2">
              Advanced multi-stage filtering ensures only verified human wallets are targeted — no bots, contracts, or scripts.
            </p>
          </div>

          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 hover:border-blue-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center mb-4">
              <Coins className="w-6 h-6 text-green-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">Auto‑Sweeping</h3>
            <p className="text-gray-400 text-sm mt-2">
              Monitor traps for incoming funds and automatically sweep native & token balances to your safe wallet.
            </p>
          </div>

          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 hover:border-blue-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center mb-4">
              <TrendingUp className="w-6 h-6 text-purple-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">Multi‑Chain</h3>
            <p className="text-gray-400 text-sm mt-2">
              One platform for Ethereum, BSC, and Polygon — with chain‑specific token configs and RPC failover.
            </p>
          </div>

          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 hover:border-blue-500/30 transition-all">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/20 flex items-center justify-center mb-4">
              <CheckCircle className="w-6 h-6 text-indigo-400" />
            </div>
            <h3 className="text-white font-semibold text-lg">Real‑Time Alerts</h3>
            <p className="text-gray-400 text-sm mt-2">
              Get Telegram notifications for every important event — from new victims to sweep confirmations.
            </p>
          </div>
        </div>
      </section>

      {/* ── Stats / Trust ── */}
      <section className="max-w-6xl mx-auto w-full px-6 py-12 border-t border-gray-800/50">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          <div>
            <p className="text-3xl font-bold text-white">500k+</p>
            <p className="text-sm text-gray-400">Generated Traps</p>
          </div>
          <div>
            <p className="text-3xl font-bold text-white">3</p>
            <p className="text-sm text-gray-400">Supported Chains</p>
          </div>
          <div>
            <p className="text-3xl font-bold text-white">$2.4M+</p>
            <p className="text-sm text-gray-400">Swept to Date</p>
          </div>
          <div>
            <p className="text-3xl font-bold text-white">99.9%</p>
            <p className="text-sm text-gray-400">Uptime</p>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="max-w-4xl mx-auto w-full px-6 py-16">
        <div className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 border border-blue-500/30 rounded-3xl p-8 md:p-12 text-center backdrop-blur-sm">
          <h2 className="text-2xl md:text-3xl font-bold text-white">
            Ready to start trapping?
          </h2>
          <p className="text-gray-300 mt-2 max-w-xl mx-auto">
            Get full access with a one‑time setup fee — no hidden costs.
          </p>
          <Link
            href="/register"
            className="inline-flex items-center gap-2 px-8 py-3 mt-6 bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/25 text-sm font-medium"
          >
            Get Started <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-gray-800/50 w-full px-6 py-6 text-center text-xs text-gray-500">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-400" />
            <span className="text-gray-300">CipherNet</span>
          </div>
          <p>&copy; {new Date().getFullYear()} CipherNet. All rights reserved.</p>
          <div className="flex gap-4">
            <Link
              href="/how-it-works"
              className="inline-flex items-center gap-2 px-5 py-2.5 border border-blue-500/40 rounded-xl text-sm font-medium text-blue-400 hover:bg-blue-500/20 hover:border-blue-400 hover:text-blue-300 transition-all duration-200 shadow-[0_0_15px_rgba(59,130,246,0.15)]"
            >
              <Info className="w-4 h-4" />
              How It Works
            </Link>
            <a href="#" className="hover:text-gray-300 transition-colors">Privacy</a>
            <a href="#" className="hover:text-gray-300 transition-colors">Terms</a>
            <a href="#" className="hover:text-gray-300 transition-colors">Support</a>
          </div>
        </div>
      </footer>

      {/* ── Telegram Contact ── */}
      <a
        href="https://t.me/wallet_hacking_toolkit"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-6 right-6 z-50 p-3 bg-blue-500 hover:bg-blue-600 rounded-full shadow-lg shadow-blue-500/30 transition-all duration-200 hover:scale-110"
      >
        <Send className="w-6 h-6 text-white" />
      </a>
    </div>
  );
}