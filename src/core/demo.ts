import chalk from 'chalk';
import {bytesToHex} from '@noble/hashes/utils';
import { NostrHandler } from './nostr.js';
import { SwapBuyer, SwapSeller } from './swap.js';

async function main(): Promise<void> {
  console.log(chalk.bold.magentaBright(`

    █████╗ ████████╗ ██████╗ ███╗   ███╗██╗ ██████╗ █████╗ ███████╗
    ██╔══██╗╚══██╔══╝██╔═══██╗████╗ ████║██║██╔════╝██╔══██╗██╔════╝
    ███████║   ██║   ██║   ██║██╔████╔██║██║██║     ███████║█████╗  
    ██╔══██║   ██║   ██║   ██║██║╚██╔╝██║██║██║     ██╔══██║██╔══╝  
    ██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║██║╚██████╗██║  ██║██║     
    ╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝     ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝         
   `));

  console.log(chalk.bold.cyan('⚡ Lightning-fast atomic swaps between Bitcoin and Nostr ⚡\n'));

  // Step 1: Create Seller
  console.log(chalk.bold.green('\n🔹 Step 1: Seller Setup'));
  const sellerPrivKey = NostrHandler.generatePrivateKey();
  const seller = new SwapSeller({nostrPrivateKey: bytesToHex(sellerPrivKey)});
  console.log(chalk.blue('  Seller Nostr Pubkey:'), chalk.yellow(seller.nostrPublicKey));

  // Step 2: Create Buyer
  console.log(chalk.bold.green('\n🔹 Step 2: Buyer Setup'));
  const buyer = new SwapBuyer();
  console.log(chalk.blue('  Buyer Bitcoin Pubkey:'), chalk.yellow(bytesToHex(buyer.bitcoinPublicKey)));

  // Step 3: Seller creates Nostr event
  console.log(chalk.bold.green('\n🔹 Step 3: Create Nostr Event'));
  const event = await seller.createEvent('AtomicAF swap: 0.1 BTC for this rare meme');
  console.log(chalk.blue('  Event ID:'), chalk.yellow(event.id));
  console.log(chalk.blue('  Event Content:'), chalk.italic(event.content));

  // Step 4: Buyer creates Bitcoin transaction
  console.log(chalk.bold.green('\n🔹 Step 4: Create Bitcoin Lock'));
  const tx = await buyer.createLockingTransaction(
    100000, // 0.001 BTC
    '0000000000000000000000000000000000000000000000000000000000000000', // Dummy UTXO
    0, // Output index
    seller.getCommitment()
  );
  console.log(chalk.blue('  Transaction ID:'), chalk.yellow(tx.getId()));
  console.log(chalk.blue('  Output Script:'), chalk.yellow(bytesToHex(tx.outs[0].script)));

  // Step 5: Create adaptor signature
  console.log(chalk.bold.green('\n🔹 Step 5: Create Adaptor Signature'));
  const adaptorSig = await buyer.createAdaptorSignature(seller.getCommitment());
  console.log(chalk.blue('  Adaptor Nonce:'), chalk.yellow(bytesToHex(adaptorSig.noncePoint)));
  console.log(chalk.blue('  Adaptor S:'), chalk.yellow(adaptorSig.s.toString()));

  // Step 6: Complete the swap
  console.log(chalk.bold.green('\n🔹 Step 6: Complete the Swap'));
  const finalSig = await buyer.completeSwap(event.sig);
  console.log(chalk.blue('  Final Signature:'), chalk.greenBright(bytesToHex(finalSig)));

  // Final output
  console.log(chalk.bold.magentaBright('\n🎉 Atomic Swap Completed Successfully! 🎉'));
  console.log(chalk.bold.white('  - Seller got paid in Bitcoin'));
  console.log(chalk.bold.white('  - Buyer obtained the authenticated Nostr event'));
  console.log(chalk.bold.white('  - No trusted third parties involved\n'));

  console.log(chalk.bold.cyan('✨ Powered by Taproot, Nostr, and cryptographic magic ✨'));
}

main().catch(console.error);