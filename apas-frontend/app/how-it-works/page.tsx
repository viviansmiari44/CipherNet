import Link from 'next/link';
import {
  Shield,
  Eye,
  Cpu,
  Coins,
  Zap,
  Wallet,
  Users,
  DollarSign,
  CheckCircle,
  ArrowRight,
  Lock,
  Server,
  Activity,
  BarChart,
} from 'lucide-react';

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-gray-200">
      {/* ── Navigation ── */}
      <nav className="w-full px-6 py-4 flex items-center justify-between border-b border-gray-700/50 backdrop-blur-sm bg-gray-900/80 sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-blue-400" />
          <span className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            CipherNet
          </span>
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="text-sm text-gray-300 hover:text-white transition-colors hidden sm:inline"
          >
            Log In
          </Link>
          <Link
            href="/register"
            className="text-sm px-4 py-2 bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/25"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="max-w-5xl mx-auto px-6 py-20 text-center">
        <div className="inline-flex items-center gap-2 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full px-4 py-1.5 text-sm font-medium mb-6">
          <Shield className="w-4 h-4" />
          <span>Full‑Stack Address Poisoning</span>
        </div>
        <h1 className="text-4xl md:text-6xl font-bold leading-tight">
          How <span className="bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">CipherNet</span> Works
        </h1>
        <p className="mt-4 text-lg text-gray-400 max-w-2xl mx-auto">
          From on‑chain observation to automated sweeping — a complete ecosystem for deploying poison traps at scale.
        </p>
      </section>

      {/* ── The Problem ── */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t border-gray-800/50">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl font-bold text-white">The Problem</h2>
            <p className="text-gray-400 mt-4 leading-relaxed">
              Address poisoning attacks are becoming increasingly sophisticated. To stay ahead, you need a 
              system that can <span className="text-white font-medium">observe, qualify, generate, fund, monitor, and sweep</span> — 
              all without manual intervention.
            </p>
            <p className="text-gray-400 mt-2 leading-relaxed">
              CipherNet automates the entire lifecycle, turning complex on‑chain activity into a streamlined 
              pipeline that works across Ethereum, BSC, and Polygon.
            </p>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-8 text-center">
            <Activity className="w-16 h-16 text-blue-400 mx-auto mb-4" />
            <p className="text-sm text-gray-400">Fully automated from start to finish</p>
          </div>
        </div>
      </section>

      {/* ── Step‑by‑Step ── */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t border-gray-800/50">
        <h2 className="text-3xl font-bold text-white text-center mb-12">
          The <span className="text-blue-400">4‑Step</span> Pipeline
        </h2>

        <div className="space-y-12">
          {/* Step 1 */}
          <div className="flex flex-col md:flex-row gap-8 items-center">
            <div className="md:w-1/3">
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-6 text-center">
                <Eye className="w-12 h-12 text-blue-400 mx-auto" />
                <span className="block mt-2 text-sm font-mono text-blue-400">Step 1</span>
              </div>
            </div>
            <div className="md:w-2/3">
              <h3 className="text-xl font-semibold text-white">Observe &amp; Qualify</h3>
              <p className="text-gray-400 mt-2 leading-relaxed">
                The <strong>collector</strong> ingests all on‑chain token and native transfers. 
                The <strong>observer</strong> then analyses this data to identify victim‑counterparty pairs 
                that have transacted at least 7 times in the last 30 days with a minimum value of $1,000. 
                These pairs are written to <code className="bg-gray-700/50 px-1 py-0.5 rounded text-xs">pending_targets_*.txt</code>.
              </p>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex flex-col md:flex-row gap-8 items-center md:flex-row-reverse">
            <div className="md:w-1/3">
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-2xl p-6 text-center">
                <Cpu className="w-12 h-12 text-purple-400 mx-auto" />
                <span className="block mt-2 text-sm font-mono text-purple-400">Step 2</span>
              </div>
            </div>
            <div className="md:w-2/3">
              <h3 className="text-xl font-semibold text-white">Generate Vanity Addresses</h3>
              <p className="text-gray-400 mt-2 leading-relaxed">
                Using GPU rentals, <strong>batch_generate.py</strong> runs the Profanity tool to 
                create a vanity address that matches the counterparty’s first 4 and last 4 characters. 
                Each successful generation costs <span className="text-white font-medium">$1</span>, 
                deducted from your credits. The private key is encrypted and stored in both the vault file 
                and the database, linked to your campaign.
              </p>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex flex-col md:flex-row gap-8 items-center">
            <div className="md:w-1/3">
              <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-6 text-center">
                <Coins className="w-12 h-12 text-green-400 mx-auto" />
                <span className="block mt-2 text-sm font-mono text-green-400">Step 3</span>
              </div>
            </div>
            <div className="md:w-2/3">
              <h3 className="text-xl font-semibold text-white">Fund Traps</h3>
              <p className="text-gray-400 mt-2 leading-relaxed">
                <strong>batch_fund.py</strong> distributes native tokens and stablecoins (USDC, USDT) 
                from your funding wallet to all generated trap addresses. The script calculates gas reserves 
                and splits the available balance equally, ensuring each trap has enough to appear legitimate.
              </p>
            </div>
          </div>

          {/* Step 4 */}
          <div className="flex flex-col md:flex-row gap-8 items-center md:flex-row-reverse">
            <div className="md:w-1/3">
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-2xl p-6 text-center">
                <Zap className="w-12 h-12 text-yellow-400 mx-auto" />
                <span className="block mt-2 text-sm font-mono text-yellow-400">Step 4</span>
              </div>
            </div>
            <div className="md:w-2/3">
              <h3 className="text-xl font-semibold text-white">Monitor &amp; Sweep</h3>
              <p className="text-gray-400 mt-2 leading-relaxed">
                <strong>re_poison.js</strong> watches for incoming transactions from victims to counterparties. 
                When a match is found, it automatically sends a dust amount of stablecoin back to the victim, 
                mimicking a “poison” transaction. <strong>sweeper.js</strong> then monitors the trap addresses 
                for any balances and sweeps them to your safe wallet, splitting profits 75/25.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Profit Split & Pricing ── */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t border-gray-800/50">
        <h2 className="text-3xl font-bold text-white text-center mb-12">
          Profit Split &amp; Pricing
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 text-center">
            <DollarSign className="w-12 h-12 text-green-400 mx-auto" />
            <p className="text-2xl font-bold text-white mt-4">60%</p>
            <p className="text-gray-400 text-sm">Your Share</p>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 text-center">
            <DollarSign className="w-12 h-12 text-purple-400 mx-auto" />
            <p className="text-2xl font-bold text-white mt-4">40%</p>
            <p className="text-gray-400 text-sm">Service Fee</p>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 text-center">
            <Cpu className="w-12 h-12 text-blue-400 mx-auto" />
            <p className="text-2xl font-bold text-white mt-4">$1 / key</p>
            <p className="text-gray-400 text-sm">Generation Fee</p>
          </div>
        </div>
        <p className="text-center text-gray-400 text-sm mt-6">
          You keep <span className="text-green-400 font-medium">60%</span> of all swept funds. 
          The remaining <span className="text-purple-400 font-medium">40%</span> powers the platform. 
          Vanity generation costs <span className="text-white font-medium">$1 per key</span>, 
          deducted from your credits.
        </p>
      </section>

      {/* ── Security ── */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t border-gray-800/50">
        <h2 className="text-3xl font-bold text-white text-center mb-12">
          Security &amp; Transparency
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 flex items-start gap-4">
            <Lock className="w-6 h-6 text-blue-400 flex-shrink-0 mt-1" />
            <div>
              <h4 className="text-white font-medium">Encrypted Vault</h4>
              <p className="text-gray-400 text-sm">All private keys are encrypted with AES‑256‑GCM before being stored.</p>
            </div>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 flex items-start gap-4">
            <Wallet className="w-6 h-6 text-green-400 flex-shrink-0 mt-1" />
            <div>
              <h4 className="text-white font-medium">HD Wallets</h4>
              <p className="text-gray-400 text-sm">Each user gets a unique deposit address derived from a master seed – no sharing.</p>
            </div>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 flex items-start gap-4">
            <Server className="w-6 h-6 text-purple-400 flex-shrink-0 mt-1" />
            <div>
              <h4 className="text-white font-medium">On‑Chain Auditability</h4>
              <p className="text-gray-400 text-sm">Every sweep and deposit is recorded on‑chain and logged in the database.</p>
            </div>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 flex items-start gap-4">
            <BarChart className="w-6 h-6 text-yellow-400 flex-shrink-0 mt-1" />
            <div>
              <h4 className="text-white font-medium">Profit Transparency</h4>
              <p className="text-gray-400 text-sm">You can view every transaction and profit share in the dashboard.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="max-w-5xl mx-auto px-6 py-16 border-t border-gray-800/50">
        <h2 className="text-3xl font-bold text-white text-center mb-12">
          Frequently Asked Questions
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
            <h4 className="text-white font-medium">Do I need my own GPU?</h4>
            <p className="text-gray-400 text-sm mt-2">No. We rent GPU capacity on demand – you only pay per generated key.</p>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
            <h4 className="text-white font-medium">Which chains are supported?</h4>
            <p className="text-gray-400 text-sm mt-2">Ethereum, Binance Smart Chain (BSC), and Polygon. More chains coming soon.</p>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
            <h4 className="text-white font-medium">What happens if a victim is caught?</h4>
            <p className="text-gray-400 text-sm mt-2">The trap is marked as “caught” and will no longer be used for future sweeps.</p>
          </div>
          <div className="bg-gray-800/40 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
            <h4 className="text-white font-medium">Can I stop a campaign?</h4>
            <p className="text-gray-400 text-sm mt-2">Yes. You can pause or terminate any campaign from the dashboard – no new jobs will start.</p>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="max-w-4xl mx-auto px-6 py-20 border-t border-gray-800/50">
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
            <Link href="/" className="hover:text-gray-300 transition-colors">Home</Link>
            <Link href="/how-it-works" className="hover:text-gray-300 transition-colors">How It Works</Link>
            <Link href="/login" className="hover:text-gray-300 transition-colors">Log In</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}