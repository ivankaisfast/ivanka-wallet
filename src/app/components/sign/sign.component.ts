import { Component, OnInit } from '@angular/core';
import BigNumber from 'bignumber.js';
import {AddressBookService} from '../../services/address-book.service';
import {BehaviorSubject} from 'rxjs';
import {WalletService} from '../../services/wallet.service';
import {NotificationService} from '../../services/notification.service';
import {UtilService, StateBlock, TxType} from '../../services/util.service';
import {WorkPoolService} from '../../services/work-pool.service';
import {AppSettingsService} from '../../services/app-settings.service';
import {ActivatedRoute} from '@angular/router';
import {NanoBlockService} from '../../services/nano-block.service';
import {ApiService} from '../../services/api.service';
import * as QRCode from 'qrcode';
import * as bip39 from 'bip39';
import * as bip39Wallet from 'nanocurrency-web';
import { QrModalService } from '../../services/qr-modal.service';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import hermes from 'hermes-channel';
import * as nanocurrency from 'nanocurrency';
const base32 = window['base32'];

const INDEX_MAX = 4294967295;

@Component({
  selector: 'app-sign',
  templateUrl: './sign.component.html',
  styleUrls: ['./sign.component.css']
})

export class SignComponent implements OnInit {
  // The multisig wasm library can be validated by running build-or-validate_musig_wasm.sh
  private wasmURL = '../../../assets/lib/musig-nano/musig_nano.wasm.b64';

  paramsString = '';
  activePanel = 'error';
  shouldSign: boolean = null; // if a block has been scanned for signing (or if it is a block to process)
  accounts = this.walletService.wallet.accounts;
  addressBookResults$ = new BehaviorSubject([]);
  showAddressBook = false;
  addressBookMatch = '';
  amount = null;
  rawAmount: BigNumber = new BigNumber(0);
  fromAccountID: any = '';
  fromAccountBalance: BigNumber = null;
  fromAddressBook = '';
  toAccountID = '';
  toAccountBalance: BigNumber = null;
  toAddressBook = '';
  toAccountStatus = null;
  currentBlock: StateBlock = null;
  previousBlock: StateBlock = null;
  txType: TxType = null;
  txTypes = TxType; // to access enum in html
  txTypeMessage = '';
  confirmingTransaction = false;
  shouldGenWork = false;
  signTypes: string[] = ['Internal Wallet or Ledger', 'Seed or Mnemonic+Index', 'Private or Expanded Key', 'Multisig'];
  signTypeSelected: string = this.signTypes[0];
  signatureAccount = '';
  signatureMessage = '';
  signatureMessageSuccess = '';
  walletAccount = null;
  nullBlock = '0000000000000000000000000000000000000000000000000000000000000000';
  qrString = null;
  qrCodeImage = null;
  qrCodeImageBlock = null;
  validSeed = false;
  validIndex = true;
  validPrivkey = false;
  sourceSecret = '';
  sourcePriv = '';
  index = '0';
  privateKey = null; // the final private key to sign with if using manual entry
  privateKeyExpanded = false; // if a private key is provided manually and it's expanded 128 char
  processedHash: string = null;
  finalSignature: string = null;
  // With v21 the 1x is the old 8x and max will be 8x due to the webgl threshold is max ffffffff00000000
  thresholds = [
    { name: '1x', value: 1 },
    { name: '2x', value: 2 },
    { name: '4x', value: 4 },
    { name: '8x', value: 8 }
  ];
  selectedThreshold = this.thresholds[0].value;
  selectedThresholdOld = this.selectedThreshold;

  /**
   MULTISIG
   */
  multisigLink = this.getMultisigLink(); // link to be shared to other multisig participants
  participants = 2;
  validParticipants = true;
  savedParticipants = 0;
  wasm = null;
  wasmErrors = ['No error', 'Internal error', 'Invalid parameter(s)', 'Invalid Participant Input'];
  musigStagePtr = null;
  musigStageNum = null;
  savedPublicKeys = [];
  tabData = [];
  tabListenerActive = false;
  tabCount = null;
  inputMultisigData = '';
  multisigAccount = '';
  outputMultisigData = '';
  activeStep = 1;
  isInvalidStage = false;
  inputAdd = '';
  validInputAdd = false;
  isInputAddDisabled = false;
  tabMode = false;
  tabChecked = false; // if multi-tab mode enabled
  blockHash = '';
  remoteTabInit = false;
  qrModal: any = null;
  qrCodeImageOutput = null;
  inputMultisigAccounts = '';
  // END MULTISIG

  constructor(
    private router: ActivatedRoute,
    private walletService: WalletService,
    private addressBookService: AddressBookService,
    private notificationService: NotificationService,
    private nanoBlock: NanoBlockService,
    private workPool: WorkPoolService,
    public settings: AppSettingsService,
    private api: ApiService,
    private util: UtilService,
    private qrModalService: QrModalService,
    private http: HttpClient) {
      // Read the wasm file for multisig
      this.getWASM().subscribe(data => {
        const wasmString = atob(data);
        const wasmBytes = new Uint8Array(wasmString.length);
        for (let i = 0; i < wasmString.length; i++) {
          wasmBytes[i] = wasmString.charCodeAt(i);
        }

        const imports = {
          wasi_snapshot_preview1: {
            fd_write: (fd, iovs, errno, nwritten) => {
              console.error('fd_write called: unimplemented');
              return 0;
            },
            proc_exit: () => {
              console.error('proc_exit called: unimplemented');
              return 0;
            },
            environ_sizes_get: () => {
              console.error('environ_sizes_get called: unimplemented');
              return 0;
            },
            environ_get: () => {
              console.error('environ_get called: unimplemented');
              return 0;
            },
            random_get: (ptr, len) => {
              crypto.getRandomValues(new Uint8Array(this.wasm.memory.buffer, ptr, len));
              return 0;
            }
            },
            wasi_unstable: {
              random_get: (ptr, len) => {
                crypto.getRandomValues(new Uint8Array(this.wasm.memory.buffer, ptr, len));
                return 0;
              }
            },
        };
        WebAssembly.instantiate(wasmBytes, imports).then(w => {
          this.wasm = w.instance.exports;
        }).catch(console.error);
      });
  }

  async ngOnInit() {
    const UIkit = window['UIkit'];
    const qrModal = UIkit.modal('#qr-code-modal');
    this.qrModal = qrModal;

    const params = this.router.snapshot.queryParams;
    this.signTypeSelected = this.walletService.isConfigured() ? this.signTypes[0] : this.signTypes[1];

    // Multisig tab listening functions
    hermes.on('tab-ping', (data) => {
      console.log('Tab was pinged');
      if (this.blockHash === data[0]) {
        // Init step for remote tab
        this.remoteTabInit = true;
        this.tabMode = true;
        this.tabChecked = true;
        this.participants = parseInt(data[2], 10);
        this.tabListener(false); // start in passive mode
        this.alertError(this.multiSign.bind(this)).bind(this)();
      } else {
        console.log('Non-matching block hash');
        this.notificationService.sendWarning('This tab has the wrong block hash', {length: 0});
      }
    });

    // Dual tab mode for auto signing
    hermes.on('sign-remote', (data) => {
      console.log('Receiving data from other tab: ' + data);
      if (!this.tabData.includes(data[1])) {
        this.tabData.push(data[1]);
      }
    });

    // Multi-tab mode checkbox
    hermes.on('multi-tab', (data) => {
      console.log('Multi-tab mode enabled');
      this.tabChecked = data;
    });

    // Multi-tab mode participant changes
    hermes.on('participants', (data) => {
      console.log('Participant count changed');
      this.participants = data;
    });

    if ('sign' in params && 'n_account' in params && 'n_previous' in params && 'n_representative' in params &&
      'n_balance' in params && 'n_link' in params) {
      this.currentBlock = {'account': params.n_account, 'previous': params.n_previous, 'representative': params.n_representative,
      'balance': params.n_balance, 'link': params.n_link, 'signature': 'n_signature' in params ? params.n_signature : '',
      'work': 'n_work' in params ? params.n_work : ''};

      this.paramsString = 'sign?sign=' + params.sign + '&n_account=' + params.n_account + '&n_previous=' + params.n_previous +
      '&n_representative=' + params.n_representative + '&n_balance=' + params.n_balance + '&n_link=' + params.n_link +
      ('n_signature' in params ? ('&n_signature=' + params.n_signature) : '') + ('n_work' in params ? ('&n_work=' + params.n_work) : '');

      // previous block won't be included with open block (or maybe if another wallet implement this feature)
      if ('p_account' in params && 'p_previous' in params && 'p_representative' in params && 'p_balance' in params && 'p_link' in params) {
        this.previousBlock = {'account': params.p_account, 'previous': params.p_previous, 'representative': params.p_representative,
        'balance': params.p_balance, 'link': params.p_link, 'signature': 'p_signature' in params ? params.p_signature : '', 'work': ''};

        this.paramsString = this.paramsString + '&p_account=' + params.p_account + '&p_previous=' + params.p_previous +
        '&p_representative=' + params.p_representative + '&p_balance=' + params.p_balance + '&p_link=' + params.p_link +
        ('p_signature' in params ? ('&p_signature=' + params.p_signature) : '');
      }

      this.shouldSign = params.sign === '1' ? true : false;
      this.shouldGenWork = this.currentBlock.work === '' && !this.shouldSign;

      // check if multisig
      if (params.participants) {
        this.signTypeSelected = this.signTypes[3];
        this.participants = parseInt(params.participants, 10);
        this.participantChange(this.participants);
      }

      // check if both new block and previous block hashes matches (balances has not been tampered with) and have valid parameters
      if (this.previousBlock && this.verifyBlock(this.currentBlock) && this.verifyBlock(this.previousBlock)) {
        // it's a send block
        if (new BigNumber(this.previousBlock.balance).gt(new BigNumber(this.currentBlock.balance))) {
          this.txType = TxType.send;
          this.txTypeMessage = 'send';
          this.rawAmount = new BigNumber(this.previousBlock.balance).minus(new BigNumber(this.currentBlock.balance));
          this.fromAccountID = this.currentBlock.account;
          this.toAccountID = this.util.account.getPublicAccountID(this.util.hex.toUint8(this.currentBlock.link));
          this.fromAccountBalance = new BigNumber(this.previousBlock.balance);
          // sending to itself
          if (this.fromAccountID === this.toAccountID) {
            this.toAccountBalance = this.fromAccountBalance;
          }
        } else if (new BigNumber(this.previousBlock.balance).eq(new BigNumber(this.currentBlock.balance)) &&
            this.previousBlock.representative !== this.currentBlock.representative && this.currentBlock.link === this.nullBlock) {
          // it's a change block
          this.txType = TxType.change;
          this.txTypeMessage = 'change representative to';
          this.rawAmount = new BigNumber(0);
          this.fromAccountID = this.currentBlock.account;
          this.toAccountID = this.currentBlock.account;
          this.fromAccountBalance = new BigNumber(this.currentBlock.balance);
          this.toAccountBalance = new BigNumber(this.currentBlock.balance);
        } else if (new BigNumber(this.previousBlock.balance).lt(
            new BigNumber(this.currentBlock.balance)) && this.currentBlock.previous !== this.nullBlock) {
          // it's a receive block
          this.txType = TxType.receive;
          this.txTypeMessage = 'receive';
          this.rawAmount = new BigNumber(this.currentBlock.balance).minus(new BigNumber(this.previousBlock.balance));

          // get from-account info if online
          let recipientInfo = null;
          try {
            recipientInfo = await this.api.blockInfo(this.currentBlock.link);
          } catch {}
          if (recipientInfo && 'block_account' in recipientInfo) {
            this.fromAccountID = recipientInfo.block_account;
          } else {
            this.fromAccountID = null;
          }

          this.toAccountID = this.currentBlock.account;
          this.toAccountBalance = new BigNumber(this.previousBlock.balance);
        } else {
          return this.notificationService.sendError(`Meaningless block. The balance and representative are unchanged!`, {length: 0});
        }

        this.amount = this.util.nano.rawToMnano(this.rawAmount).toString(10);

        // Extract block hash (used with multisig)
        const block: StateBlock = {account: this.currentBlock.account, link: this.currentBlock.link, previous: this.currentBlock.previous,
          representative: this.currentBlock.representative, balance: this.currentBlock.balance, signature: null, work: null};
        this.blockHash = this.util.hex.fromUint8(this.util.nano.hashStateBlock(block));

        this.prepareTransaction();
      } else if (!this.previousBlock && this.verifyBlock(this.currentBlock)) {
        // No previous block present (open block)
        // TODO: Make all block subtypes also possible to sign even if previous block is missing, but with less displayed data
        if (this.currentBlock.previous === this.nullBlock) {
          this.txType = TxType.open;
          this.txTypeMessage = 'receive';
          this.rawAmount = new BigNumber(this.currentBlock.balance);

          // get from-account info if online
          let recipientInfo = null;
          try {
            recipientInfo = await this.api.blockInfo(this.currentBlock.link);
          } catch {}

          if (recipientInfo && 'block_account' in recipientInfo) {
            this.fromAccountID = recipientInfo.block_account;
          } else {
            this.fromAccountID = null;
          }

          this.toAccountID = this.currentBlock.account;
          this.toAccountBalance = new BigNumber(0);
        } else {
          return this.notificationService.sendError(`Only OPEN block is currently supported when previous block is missing`, {length: 0});
        }

        this.amount = this.util.nano.rawToMnano(this.rawAmount).toString(10);
        this.prepareTransaction();
      } else {
        return;
      }
    } else {
      this.notificationService.sendError(`Incorrect parameters provided for signing!`, {length: 0});
      return;
    }

    this.addressBookService.loadAddressBook();
  }

  verifyBlock(block: StateBlock) {
    if (this.util.account.isValidAccount(block.account) &&
      this.util.account.isValidAccount(block.representative) &&
      this.util.account.isValidAmount(block.balance) &&
      this.util.nano.isValidHash(block.previous) &&
      this.util.nano.isValidHash(block.link)) {
      return true;
    } else {
      this.notificationService.sendError(`The provided blocks contain invalid values!`, {length: 0});
      return false;
    }
  }

  verifyBlockHash(currentBlock: StateBlock, previousBlock: StateBlock) {
    const block: StateBlock = {account: previousBlock.account, link: previousBlock.link, previous: previousBlock.previous,
      representative: previousBlock.representative, balance: previousBlock.balance, signature: null, work: null};
    const previousHash = this.util.hex.fromUint8(this.util.nano.hashStateBlock(block));
    if (!currentBlock.previous || previousHash !== currentBlock.previous) {
      this.notificationService.sendError(`The hash of the previous block does not match the frontier in the new block!`, {length: 0});
    }
    return currentBlock.previous && previousHash === currentBlock.previous;
  }

  searchAddressBook() {
    this.showAddressBook = true;
    const search = this.toAccountID || '';
    const addressBook = this.addressBookService.addressBook;

    const matches = addressBook
      .filter(a => a.name.toLowerCase().indexOf(search.toLowerCase()) !== -1)
      .slice(0, 5);

    this.addressBookResults$.next(matches);
  }

  signTypeChange() {
    this.signatureMessage = '';
    this.signatureMessageSuccess = '';
    let params = this.paramsString;

    switch (this.signTypeSelected) {
      // wallet
      case this.signTypes[0]:
        this.walletAccount = this.accounts.find(a => a.id.replace('xrb_', 'nano_') === this.signatureAccount);
        if (!this.walletAccount) {
          this.signatureMessage = 'Could not find a matching wallet account to sign with. Make sure it\'s added under your accounts';
        } else {
          this.signatureMessageSuccess = 'A matching account found!';
        }
        break;

      case this.signTypes[1]:
        this.seedChange(this.sourceSecret);
        break;

      case this.signTypes[2]:
        this.privkeyChange(this.sourcePriv);
        break;

      case this.signTypes[3]:
        this.privkeyChangeMulti(this.sourcePriv);
        params = this.paramsString + '&participants=' + this.participants;
        this.multisigLink = this.getMultisigLink();
        break;
    }
    this.setURLParams(params);
  }

  powChange() {
    if (this.shouldGenWork) {
      this.prepareWork();
    }
  }

  changeThreshold() {
    // multiplier has changed, clear the cache and recalculate
    if (this.selectedThreshold !== this.selectedThresholdOld) {
      const workBlock = this.txType === TxType.open ? this.util.account.getAccountPublicKey(this.toAccountID) : this.currentBlock.previous;
      this.workPool.removeFromCache(workBlock);
      console.log('PoW multiplier changed: Clearing cache');
      this.powChange();
    }
  }

  prepareWork() {
    // The block has been verified
    if (this.toAccountID) {
      console.log('Precomputing work...');
      const workBlock = this.txType === TxType.open ? this.util.account.getAccountPublicKey(this.toAccountID) : this.currentBlock.previous;
      this.workPool.addWorkToCache(workBlock, this.selectedThreshold);
    }
  }

  async prepareTransaction() {
    this.fromAddressBook = this.addressBookService.getAccountName(this.fromAccountID);
    this.toAddressBook = this.addressBookService.getAccountName(this.toAccountID);

    this.activePanel = 'confirm';
    // Start precopmuting the work...
    if (this.shouldGenWork) {
      this.prepareWork();
    }

    if (this.txType === TxType.send || this.txType === TxType.change) {
      this.signatureAccount = this.fromAccountID.replace('xrb_', 'nano_').toLowerCase();
    } else if (this.txType === TxType.receive || this.txType === TxType.open) {
      this.signatureAccount = this.toAccountID.replace('xrb_', 'nano_').toLowerCase();
    }

    if (this.shouldSign) {
      this.signTypeChange();
    }
  }

  // Create signature for the block
  async confirmTransaction(signature = '') {
    let walletAccount = this.walletAccount;
    let isLedger = this.walletService.isLedgerWallet();

    // using internal wallet
    if (this.signTypeSelected === this.signTypes[0] && walletAccount) {
      if (this.walletService.walletIsLocked()) {
        return this.notificationService.sendWarning('Wallet must be unlocked for signing with it');
      }
    } else if (this.signTypeSelected === this.signTypes[0]) {
      return this.notificationService.sendWarning('Could not find a matching wallet account to sign with. Make sure it\'s added under your accounts');
    }

    // using seed or private key
    if ((this.signTypeSelected === this.signTypes[1] && !this.validSeed) || (this.signTypeSelected === this.signTypes[2]
      && !this.validPrivkey) || (this.signTypeSelected === this.signTypes[3] && !this.validPrivkey)) {
        return this.notificationService.sendWarning('Could not find a valid private key to sign with.');
      }
    if (this.signTypeSelected === this.signTypes[1] || this.signTypeSelected === this.signTypes[2]) {
      isLedger = false;
      // create dummy wallet that only contains needed elements for signature
      walletAccount = {keyPair: {secretKey: this.util.hex.toUint8(this.privateKey), expanded: this.privateKeyExpanded}};
    }

    this.confirmingTransaction = true;

    // sign the block (if not multisig)
    let block: StateBlock;
    if (this.signTypeSelected !== this.signTypes[3]) {
      block = await this.nanoBlock.signOfflineBlock(walletAccount, this.currentBlock,
        this.previousBlock, this.txType, this.shouldGenWork, this.selectedThreshold, isLedger);
      console.log('Signature: ' + block.signature || 'Error');
      console.log('Work: ' + block.work || 'Not applied');

      if (!block.signature) {
        this.confirmingTransaction = false;
        return this.notificationService.sendError('The block could not be signed!', {length: 0});
      }
    } else {
      // Multisig signature
      block = this.currentBlock;

      // Check if aggregated multisig account matches the account we want to sign
      if (block.account !== this.multisigAccount) {
        return this.notificationService.sendError('The private keys does not match the multisig account you want to sign!', {length: 0});
      }
      // Check the given signature format
      if (!this.util.nano.isValidSignature(signature)) {
        return this.notificationService.sendError('The multi-signature was invalid!', {length: 0});
      }
      block.signature = signature;
      const openEquiv = this.txType === TxType.open;
      // Start precomputing the work...
      if (this.shouldGenWork) {
        // For open blocks which don't have a frontier, use the public key of the account
        const workBlock = openEquiv ? this.util.account.getAccountPublicKey(this.multisigAccount) : block.previous;
        if (!this.workPool.workExists(workBlock)) {
          this.notificationService.sendInfo(`Generating Proof of Work...`, { identifier: 'pow', length: 0 });
        }

        block.work = await this.workPool.getWork(workBlock, this.selectedThreshold);
        this.notificationService.removeNotification('pow');
        this.workPool.removeFromCache(workBlock);
      }
    }

    this.qrString = null;
    this.qrCodeImageBlock = null;
    this.finalSignature = null;

    const UIkit = window['UIkit'];
    const modal = UIkit.modal('#signed-modal');
    modal.show();

    this.finalSignature = block.signature;

    try {
      this.clean(block);
      if (this.previousBlock) {
        this.clean(this.previousBlock);
      }
      if (this.previousBlock) {
        this.qrString = 'nanoprocess:{"block":' + JSON.stringify(block) +
        ',"previous":' + JSON.stringify(this.previousBlock) + '}';
      } else {
        this.qrString = 'nanoprocess:{"block":' + JSON.stringify(block) + '}';
      }

      const qrCode = await QRCode.toDataURL(this.qrString, { errorCorrectionLevel: 'L', scale: 16 });
      this.qrCodeImageBlock = qrCode;
    } catch (error) {
      this.confirmingTransaction = false;
      console.log(error);
      return this.notificationService.sendError('The block could not be signed!', {length: 0});
    }

    this.confirmingTransaction = false;
    this.notificationService.sendSuccess('The block has been signed and can be sent to the network!');
  }

  // Send signed block to the network
  async confirmBlock() {
    this.confirmingTransaction = true;
    const workBlock = this.txType === TxType.open ? this.util.account.getAccountPublicKey(this.toAccountID) : this.currentBlock.previous;
    if (this.shouldGenWork) {
      // For open blocks which don't have a frontier, use the public key of the account
      if (!this.workPool.workExists(workBlock)) {
        this.notificationService.sendInfo(`Generating Proof of Work...`, { identifier: 'pow', length: 0 });
      }

      if (this.txType === TxType.receive || this.txType === TxType.open) {
        this.currentBlock.work = await this.workPool.getWork(workBlock, 1 / 64);
      } else {
        this.currentBlock.work = await this.workPool.getWork(workBlock, 1);
      }
      this.notificationService.removeNotification('pow');

      this.workPool.removeFromCache(workBlock);
    }

    // Validate that frontier is still the same and the previous balance is correct
    if (this.txType !== TxType.open) {
      const accountInfo = await this.api.accountInfo(this.signatureAccount);
      if ('frontier' in accountInfo && accountInfo.frontier !== this.currentBlock.previous) {
        this.confirmingTransaction = false;
        return this.notificationService.sendError('The block can\'t be processed because the account frontier has changed!', {length: 0});
      }
      if ('balance' in accountInfo && accountInfo.balance !== this.previousBlock.balance) {
        this.confirmingTransaction = false;
        return this.notificationService.sendError('The block can\'t be processed because the current account balance does not match the previous block!', {length: 0});
      }
    }

    if (this.currentBlock.signature === '') {
      this.confirmingTransaction = false;
      return this.notificationService.sendError('The block can\'t be processed because the signature is missing!', {length: 0});
    }

    if (this.currentBlock.work === '') {
      this.confirmingTransaction = false;
      return this.notificationService.sendError('The block can\'t be processed because work is missing!', {length: 0});
    }

    // Process block
    const blockData: any = this.currentBlock;
    blockData.type = 'state';
    const processResponse = await this.api.process(blockData, this.txType);
    if (processResponse && processResponse.hash) {
      // Add new hash into the work pool but does not make much sense for this case
      // this.workPool.addWorkToCache(processResponse.hash);
      this.workPool.removeFromCache(workBlock);
      this.processedHash = processResponse.hash;
      this.notificationService.sendSuccess('Successfully processed the block!');
    } else {
      console.log(processResponse);
      this.notificationService.sendError('There was an error while processing the block! Please see the console.', {length: 0});
    }
    this.confirmingTransaction = false;
  }

  copied() {
    this.notificationService.removeNotification('success-copied');
    this.notificationService.sendSuccess(`Successfully copied to clipboard!`, { identifier: 'success-copied' });
  }

  clean(obj) {
    for (const propName in obj) {
      if (obj[propName] === null || obj[propName] === undefined) {
        delete obj[propName];
      }
    }
  }

  seedChange(input) {
    const keyType = this.checkMasterKey(input);
    this.validSeed = keyType !== null;
    if (this.validSeed && this.validIndex) {
      this.verifyKey(keyType, input, Number(this.index));
    } else {
      this.signatureMessage = '';
      this.signatureMessageSuccess = '';
    }
  }

  privkeyChange(input) {
    const privKey = this.convertPrivateKey(input);
    if (privKey !== null) {
      // Match given block account with with private key
      const pubKey = this.util.account.generateAccountKeyPair(this.util.hex.toUint8(privKey), this.privateKeyExpanded).publicKey;
      const address = this.util.account.getPublicAccountID(pubKey);
      if (address === this.signatureAccount ) {
        this.validPrivkey = true;
        this.privateKey = privKey;
        this.signatureMessage = '';
        this.signatureMessageSuccess = 'The private key match the account!';
        return;
      } else {
        this.signatureMessage = 'The account for this private key does not match!';
      }
    } else {
      this.signatureMessage = '';
    }
    this.signatureMessageSuccess = '';
    this.validPrivkey = false;
    this.privateKey = '';
  }

  indexChange(index) {
    this.validIndex = true;
    if (this.util.string.isNumeric(index) && index % 1 === 0) {
      index = parseInt(index, 10);
      if (!this.util.nano.isValidIndex(index)) {
        this.validIndex = false;
      }
      if (index > INDEX_MAX) {
        this.validIndex = false;
      }
    } else {
      this.validIndex = false;
    }

    if (this.validSeed && this.validIndex) {
      const keyType = this.checkMasterKey(this.sourceSecret);
      this.verifyKey(keyType, this.sourceSecret, Number(this.index));
    } else {
      this.signatureMessage = '';
      this.signatureMessageSuccess = '';
    }
  }

  verifyKey(keyType: string, input: string, index: number) {
    let seed = '';
    let privKey1 = '';
    let privKey2 = '';

    // input is mnemonic
    if (keyType === 'mnemonic') {
      seed = bip39.mnemonicToEntropy(input).toUpperCase();
      // seed must be 64 or the nano wallet can't be created.
      // This is the reason 12-words can't be used because the seed would be 32 in length
      if (seed.length !== 64) {
        this.notificationService.sendWarning(`Mnemonic not 24 words`);
        return;
      }
    }

    // nano seed
    if (keyType === 'nano_seed' || seed !== '' || keyType === 'bip39_seed') {
      if (seed === '') { // seed from input, no mnemonic
        seed = input;
      }
      // start with blake2b derivation
      if (keyType !== 'bip39_seed') {
          privKey1 = this.util.hex.fromUint8(this.util.account.generateAccountSecretKeyBytes(this.util.hex.toUint8(seed), index));
      }
      // also check using bip39/44 derivation
      let bip39Seed;
      // take 128 char bip39 seed directly from input or convert it from a 64 char nano seed (entropy)
      if (keyType === 'bip39_seed') {
        bip39Seed = input;
      } else {
        bip39Seed = bip39Wallet.wallet.generate(seed).seed;
      }
      privKey2 = bip39Wallet.wallet.accounts(bip39Seed, index, index)[0].privateKey;
    }

    // Match given block account with any of the private keys extracted
    const pubKey1 = this.util.account.generateAccountKeyPair(this.util.hex.toUint8(privKey1), this.privateKeyExpanded).publicKey;
    const pubKey2 = this.util.account.generateAccountKeyPair(this.util.hex.toUint8(privKey2), this.privateKeyExpanded).publicKey;
    const address1 = this.util.account.getPublicAccountID(pubKey1);
    const address2 = this.util.account.getPublicAccountID(pubKey2);

    if (address1 === this.signatureAccount || address2 === this.signatureAccount ) {
      if (address1 === this.signatureAccount) {
        this.privateKey = privKey1;
      } else {
        this.privateKey = privKey2;
      }
      this.signatureMessage = '';
      this.signatureMessageSuccess = 'A matching private key found!';
    } else {
      this.signatureMessage = 'Could not find a matching private key!';
      this.signatureMessageSuccess = '';
    }
  }

  // Validate type of master key
  checkMasterKey(key) {
    // validate nano seed
    if (key.length === 64) {
      if (this.util.nano.isValidSeed(key)) {
        return 'nano_seed';
      }
    }
    // validate bip39 seed
    if (key.length === 128) {
      if (this.util.hex.isHex(key)) {
        return 'bip39_seed';
      }
    }
    // validate mnemonic
    if (bip39.validateMnemonic(key)) {
      return 'mnemonic';
    }
    return null;
  }

  convertPrivateKey(key) {
    if (key.length === 128) {
      this.privateKeyExpanded = true;
      // expanded key includes deterministic R value material which we ignore
      return key.substring(0, 64);
    } else if (key.length === 64) {
      return key;
    } else {
      return null;
    }
  }

  // open qr reader modal
  openQR(reference, type) {
    const qrResult = this.qrModalService.openQR(reference, type);
    qrResult.then((data) => {
      switch (data.reference) {
        case 'seed1':
          this.sourceSecret = data.content;
          this.seedChange(data.content);
          break;
        case 'priv1':
          this.sourcePriv = data.content;
          if (this.signTypeSelected === this.signTypes[2]) {
            this.privkeyChange(data.content);
          } else if (this.signTypeSelected === this.signTypes[3]) {
            this.privkeyChangeMulti(data.content);
          }
          break;
      }
    }, () => {}
    );
  }

  async generateOutputQR() {
    const qrCode = await QRCode.toDataURL(`${this.outputMultisigData}`, { errorCorrectionLevel: 'M', scale: 16 });
    this.qrCodeImageOutput = qrCode;
  }

  // Replace the address bar content
  setURLParams(params) {
    if (window.history.pushState) {
      try {
        window.history.replaceState(null, null, '/' + params);
      } catch (error) {
        // console.log(error)
      }
    }
  }

  /**
   * MULTISIG
   */

  // Load multisig rust library from local file via http
  getWASM(): Observable<any> {
    return this.http.get(this.wasmURL, {headers: new HttpHeaders({
      'Accept': 'text/html, application/xhtml+xml, */*',
      'Content-Type': 'application/x-www-form-urlencoded'
    }),
    responseType: 'text'});
  }

  privkeyChangeMulti(input) {
    const privKey = this.convertPrivateKey(input);
    if (privKey !== null) {
      if (this.util.nano.isValidHash(privKey)) {
        this.validPrivkey = true;
        this.privateKey = privKey;
        this.signatureMessage = '';
        return;
      } else {
        this.signatureMessage = 'Invalid private key';
      }
    } else {
      this.signatureMessage = '';
    }
    this.signatureMessageSuccess = '';
    this.validPrivkey = false;
    this.privateKey = '';
  }

  // Start signing procedure using multiple tabs
  runMultiTabs() {
    console.log('Starting automatic tab signing');
    // Ping other tabs and make sure enough of them respond and with correct hash
    this.tabCount = 1;
    hermes.on('tab-pong', (data) => {
      console.log('Tab ' + this.tabCount + ' responded');
      if (this.blockHash === data[0]) {
        this.tabCount++;
        if (this.tabCount === this.participants) {
          hermes.off('tab-pong'); // unsubscribe
          // Start the process
          console.log('Starting step 1 from local tab');
          this.tabListener(false); // start in passive mode to wait for signing process
          // Init step
          this.alertError(this.multiSign.bind(this)).bind(this)();
        }
      }
    });
    this.tabMode = true,
    console.log('Send ping to other tabs');
    hermes.send('tab-ping', [this.blockHash, '', this.participants]);
    // Set a timeout
    setTimeout(() => {  this.checkTabs(); }, 2000);
  }

  checkTabs() {
    if (this.tabCount < this.participants) {
      hermes.off('tab-pong'); // unsubscribe
      return this.notificationService.sendWarning('Make sure you have enough tabs running with the same block hash');
    }
  }

  // Checking input tab data and act when enough data is available for the current active step
  tabListener(activate = false) {
    this.tabListenerActive = activate ? true : this.tabListenerActive;
    if (this.tabListenerActive) {
      const stepData = [];
      for (const data of this.tabData) {
        if (data.substring(0, 1) === (this.activeStep - 1).toString()) {
          stepData.push(data);
        }
      }
      // Enough data for this step
      if (stepData.length >= this.participants - 1) {
        this.tabListenerActive = false;
        // Input the data and let the automation start
        for (const data of stepData) {
          this.inputAdd = data; // emulate user input
          this.inputAddChange(data);
        }
      }
    }

    if (this.tabMode) {
      setTimeout(() => {  this.tabListener(); }, 100);
    }
  }

  resetMultisig() {
    this.participants = 2;
    this.validParticipants = true;
    this.savedParticipants = 0;
    this.musigStagePtr = null;
    this.musigStageNum = null;
    this.savedPublicKeys = [];
    this.tabData = [];
    this.tabListenerActive = false;
    this.tabCount = null;
    this.inputMultisigData = '';
    this.multisigAccount = '';
    this.outputMultisigData = '';
    this.qrCodeImageOutput = null;
    this.activeStep = 1;
    this.isInvalidStage = false;
    this.inputAdd = '';
    this.validInputAdd = false;
    this.isInputAddDisabled = false;
    this.tabMode = false;
    this.tabChecked = false;
    this.remoteTabInit = false;
    this.privateKey = '';
    this.sourcePriv = '';
    this.validPrivkey = false;
    this.inputMultisigAccounts = '';
    this.confirmingTransaction = false;

    this.setURLParams(this.paramsString + '&participants=' + this.participants);
    this.multisigLink = this.getMultisigLink();
  }
  // activating multi-tab mode
  tabModeCheck() {
    hermes.send('multi-tab', this.tabChecked);
    if (this.tabChecked) {
      hermes.send('participants', this.participants);
      hermes.send('hash', this.blockHash);
    }
  }

  // number of participants changes
  participantChange(index) {
    if (this.util.string.isNumeric(index) && index >= 2 && index < 1000) {
      this.validParticipants = true;
      this.participants = parseInt(index, 10);
      this.setURLParams(this.paramsString + '&participants=' + index);
      this.multisigLink = this.getMultisigLink();
    } else {
      this.validParticipants = false;
    }

    if (this.validParticipants) {
      if (this.tabChecked) {
        hermes.send('participants', this.participants);
      }
    } else {
      this.signatureMessage = '';
      this.signatureMessageSuccess = '';
    }
  }

  // generate shared data to be sent to other participants
  getMultisigLink() {
    return 'nanosign:{"block":' + JSON.stringify(this.currentBlock) +
    ',"previous":' + JSON.stringify(this.previousBlock) +  ',"participants":' + this.participants + '}';
  }

  // the field for input data has changed
  inputAddChange(hashString) {
    const hashFull = hashString.substring(2);
    let valid = true;
    if (hashFull.length === 64) {
      if (!this.util.nano.isValidHash(hashFull)) {
        valid = false;
      }
    } else if (hashFull.length === 128) {
      if (!this.util.nano.isValidHash(hashFull.substring(0, 64)) || !this.util.nano.isValidHash(hashFull.substring(64, 128))) {
        valid = false;
      }
    } else {
      valid = false;
    }
    const step = parseInt(hashString.substring(0, 1), 10);
    let correctStep = true;
    if (step !== this.activeStep - 1) {
      correctStep = false;
    }

    if (!valid || !correctStep) {
      this.validInputAdd = false;
      if (hashString !== '') {
        if (!correctStep) {
          console.log('Wrong input for this step. Expected step ' + (this.activeStep - 1));
          this.notificationService.removeNotification('wrong-input');
          this.notificationService.sendWarning('Wrong input for this step. Expected step ' + (this.activeStep - 1), {identifier: 'wrong-input'});
        }
      }
      return;
    }
    this.validInputAdd = true;
    // Automatic tab mode is running, go ahead with the next step
    if (this.tabMode) {
      this.addMultisigInputData();
    }
  }

  // append input data to complete data
  addMultisigInputData() {
    if (!this.validInputAdd) {
      this.notificationService.sendWarning('Data not in valid format');
      return;
    }
    if (this.outputMultisigData.includes(this.inputAdd.substring(2))) {
      this.notificationService.sendWarning('Don\'t add your own output');
      return;
    }
    if (this.inputMultisigData.includes(this.inputAdd.substring(2))) {
      this.notificationService.sendWarning('Data already added');
      return;
    }
    if (this.savedParticipants >= this.participants) {
      this.notificationService.sendWarning('You already have all data needed');
    }
    // Derive address and add to stored list (not used but could be nice feedback for the user)
    if (this.activeStep === 2) {
      this.inputMultisigAccounts = this.inputMultisigAccounts +
      nanocurrency.deriveAddress(this.inputAdd.substring(66), {useNanoPrefix: true}) + '\n';
      // Don't calculate multisig account until all participant data has been entered
      if (this.savedParticipants === this.participants - 1) {
        this.alertError(this.aggregate.bind(this)).bind(this)();
      }
    }

    this.inputMultisigData = this.inputMultisigData + this.inputAdd.substring(2).toUpperCase() + '\n',
    this.savedParticipants = this.savedParticipants + 1;
    this.inputAdd = '';
    this.validInputAdd = false;
    if (this.savedParticipants === this.participants - 1) {
      this.isInputAddDisabled = true;
      // Automatic tab mode is running, go ahead with the next step
      if (this.tabMode) {
        this.tabListenerActive = false; // pause processing input data
        this.alertError(this.multiSign.bind(this)).bind(this)();
      }
    }
  }

  // copy data to be shared
  copyUrl() {
    const dummy = document.createElement('input');
    document.body.appendChild(dummy);
    dummy.setAttribute('value', this.multisigLink);
    dummy.select();
    const success = document.execCommand('copy');
    document.body.removeChild(dummy);

    if (success) {
      this.notificationService.sendSuccess('Successfully copied multisig URL to clipboard!');
    } else {
      this.notificationService.sendError('Failed to copy multisig URL to clipboard!');
    }
  }

  alertError(f) {
    return function () {
      try {
        f();
      } catch (err) {
        console.error(err.toString());
        this.notificationService.sendError(err.toString(), {length: 6000});
      }
    };
  }

  copyToWasm(bytes, ptr = null) {
    if (!ptr) {
      ptr = this.wasm.musig_malloc(bytes.length);
    }
    const buf = new Uint8Array(this.wasm.memory.buffer, ptr, bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      buf[i] = bytes[i];
    }
    return ptr;
  }
  copyFromWasm(ptr, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.wasm.memory.buffer[ptr + i];
    }
    return out;
  }

  wasmError(errCode) {
    throw new Error('Multisig error ' + errCode + ': ' + this.wasmErrors[errCode]);
  }

  // combine public keys into a multisig account
  aggregate(runWithPubkeys) {
    let addresses = [];
    if (this.savedPublicKeys.length > 1) {
      for (const pubKey of this.savedPublicKeys) {
        addresses.push(nanocurrency.deriveAddress(pubKey, {useNanoPrefix: true}));
      }
    } else {
      addresses = this.inputMultisigAccounts.trim().split('\n');
      if (addresses.length < 2) {
          throw new Error('This requires at least 2 newline-separated addresses');
      }
    }

    const pubkeys = [];
    for (let address of addresses) {
      address = address.trim();
      if (!address.startsWith('xrb_') && !address.startsWith('nano_')) {
        throw new Error('Nano addresses must start with xrb_ or nano_');
      }
      address = address.split('_', 2)[1];
      try {
        const bytes = base32.decode(address);
        if (bytes.length !== 37) {
          throw new Error('Wrong nano address length');
        }
        const pubkey = bytes.subarray(0, 32);
        const checksum_ = this.util.account.getAccountChecksum(pubkey);
        if (!this.util.array.equalArrays(bytes.subarray(32), checksum_)) {
          throw new Error('Invalid nano address checksum');
        }
        pubkeys.push(pubkey);
      } catch (err_) {
          console.error(err_.toString());
          throw new Error('Invalid nano address (bad character?)');
      }
    }
    const pubkeyPtrs = this.wasm.musig_malloc(pubkeys.length * 4);
    const pubkeyPtrsBuf = new Uint32Array(this.wasm.memory.buffer, pubkeyPtrs, pubkeys.length);
    for (let i = 0; i < pubkeys.length; i++) {
      pubkeyPtrsBuf[i] = this.copyToWasm(pubkeys[i]);
    }
    const outPtr = this.wasm.musig_malloc(33);
    const outBuf = new Uint8Array(this.wasm.memory.buffer, outPtr, 33);
    outBuf[0] = 0;
    this.wasm.musig_aggregate_public_keys(pubkeyPtrs, pubkeys.length, outPtr, outPtr + 1);
    if (runWithPubkeys) runWithPubkeys(pubkeyPtrs, pubkeys.length);
    for (let i = 0; i < pubkeyPtrsBuf.length; i++) {
      this.wasm.musig_free(pubkeyPtrsBuf[i]);
    }
    this.wasm.musig_free(pubkeyPtrs);
    const err = outBuf[0];
    if (err !== 0) {
      this.wasm.musig_free(outPtr);
        throw this.wasmError(err);
    }
    const aggPubkey = outBuf.subarray(1).slice();
    const checksum = this.util.account.getAccountChecksum(aggPubkey);
    const fullAddress = new Uint8Array(37);
    for (let i = 0; i < 32; i++) {
      fullAddress[i] = aggPubkey[i];
    }
    for (let i = 0; i < 5; i++) {
      fullAddress[32 + i] = checksum[i];
    }
    const fullAddressFinal = 'nano_' + base32.encode(fullAddress);
    this.multisigAccount = fullAddressFinal;
    console.log('Multisig Account: ' + fullAddressFinal);
    this.wasm.musig_free(outPtr);
    return aggPubkey;
  }

  startMultisig() {
    if (this.validPrivkey) {
      if (this.tabChecked) {
        this.runMultiTabs();
      } else {
        this.alertError(this.multiSign.bind(this)).bind(this)();
      }
    } else {
      this.notificationService.sendWarning('Invalid private key!');
    }
  }

  multiSign() {
    // Stage 0 (init)
    if (!this.musigStagePtr) {
      if (!this.util.nano.isValidHash(this.privateKey)) {
        throw new Error('Invalid private key');
      }
      if (!this.util.nano.isValidHash(this.blockHash)) {
        throw new Error('Invalid block hash');
      }
      const outPtr = this.wasm.musig_malloc(65);
      const outBuf = new Uint8Array(this.wasm.memory.buffer, outPtr, 65);
      outBuf[0] = 0;
      try {
        this.musigStagePtr = this.wasm.musig_stage0(outPtr, outPtr + 33);
        this.musigStageNum = 0;
      } catch (err_) {
        if (this.musigStagePtr) {
          this.wasm.musig_free_stage0(this.musigStagePtr);
        }
        this.musigStagePtr = undefined;
        this.musigStageNum = undefined;
        throw err_;
      }
      const err = outBuf[0];
      if (err !== 0) {
        this.musigStagePtr = undefined;
        this.musigStageNum = undefined;
        this.wasm.musig_free(outPtr);
        throw this.wasmError(err);
      }

      // Combine output with public key
      const output = this.activeStep + ':' + this.util.hex.fromUint8(outBuf.subarray(33)) + nanocurrency.derivePublicKey(this.privateKey);
      this.activeStep = this.activeStep + 1;
      this.outputMultisigData = output.toUpperCase();
      this.generateOutputQR();
      this.multisigAccount = '';
      this.wasm.musig_free(outPtr);

      // If using multi-tabs, send back the result
      if (this.tabMode) {
        if (this.remoteTabInit) {
          this.remoteTabInit = false;
          console.log('Responding with pong');
          this.tabListenerActive = true; // resume processing input data
          hermes.send('tab-pong', [this.blockHash, this.outputMultisigData]);
          hermes.send('sign-remote', [this.blockHash, this.outputMultisigData]);
        } else {
          console.log('Sending signing data');
          this.tabListenerActive = true; // resume processing input data
          hermes.send('sign-remote', [this.blockHash, this.outputMultisigData]);
        }
      }

      // Further steps
    } else {
      const protocolInputs = this.inputMultisigData.trim().split('\n').map(s => s.trim().toLowerCase().substring(0, 64));
      const protocolInputPtrs = this.wasm.musig_malloc(protocolInputs.length * 4);
      const protocolInputPtrsBuf = new Uint32Array(this.wasm.memory.buffer, protocolInputPtrs, protocolInputs.length);
      for (let i = 0; i < protocolInputs.length; i++) {
          protocolInputPtrsBuf[i] = this.copyToWasm(this.util.hex.toUint8(protocolInputs[i]));
      }

      let privateKeyPtr;
      if (this.musigStageNum === 0) {
        privateKeyPtr = this.copyToWasm(this.util.hex.toUint8(this.privateKey));
      }

      const outLen = (this.musigStageNum === 2) ? 65 : 33;
      const outPtr = this.wasm.musig_malloc(outLen);
      const outBuf = new Uint8Array(this.wasm.memory.buffer, outPtr, outLen);
      outBuf[0] = 0;
      let newStagePtr;

      if (this.musigStageNum === 0) {
        // Extract public keys from the participants
        this.savedPublicKeys = this.inputMultisigData.trim().split('\n').map(s => s.trim().toLowerCase().substring(64, 128));
        // Add the public key from self
        const pub = nanocurrency.derivePublicKey(this.privateKey);
        this.savedPublicKeys.push(pub);

        const blockhash = this.util.hex.toUint8(this.blockHash);
        const blockhashPtr = this.copyToWasm(blockhash);
        this.aggregate((pubkeys, pubkeysLen) => {
          const flags = 0; // Set to 1 if private key is a raw/expanded scalar (unusual)
          newStagePtr = this.wasm.musig_stage1(this.musigStagePtr, privateKeyPtr, pubkeys, pubkeysLen, flags,
            blockhashPtr, blockhash.length, protocolInputPtrs, protocolInputs.length, outPtr, null, outPtr + 1);
        });
        this.musigStageNum = 0;
        this.wasm.musig_free(privateKeyPtr);
        this.wasm.musig_free(blockhashPtr);

      } else if (this.musigStageNum === 1) {
          newStagePtr = this.wasm.musig_stage2(this.musigStagePtr, protocolInputPtrs, protocolInputs.length, outPtr, outPtr + 1);
      } else if (this.musigStageNum === 2) {
          newStagePtr = this.wasm.musig_stage3(this.musigStagePtr, protocolInputPtrs, protocolInputs.length, outPtr, outPtr + 1);
      } else {
        this.wasm.musig_free(outPtr);
          throw new Error('Unexpected musigStageNum ' + this.musigStageNum);
      }
      const err = outBuf[0];
      if (err !== 0) {
        this.wasm.musig_free(outPtr);
          if (err === 1) {
              // Now in an invalid state
              this.isInvalidStage = true;
          }
          throw this.wasmError(err);
      }
      this.musigStagePtr = newStagePtr;
      this.musigStageNum++;

      // Finished
      if (this.musigStageNum === 3) {
        this.isInvalidStage = true;
        this.inputMultisigData = '';
        this.outputMultisigData = '';
        this.qrCodeImageOutput = null;
        this.tabMode = false;
        this.tabListenerActive = false;
        this.inputMultisigAccounts = '';
        this.confirmTransaction(this.util.hex.fromUint8(outBuf.subarray(1)));
      } else {
        this.outputMultisigData = this.activeStep + ':' + this.util.hex.fromUint8(outBuf.subarray(1));
        this.generateOutputQR();
        this.inputMultisigData = '';
        this.isInputAddDisabled = false;
        this.savedParticipants = 0;
        this.inputAdd = '';
        this.inputMultisigAccounts = '';
        this.validInputAdd = false;
        this.activeStep = this.activeStep + 1;
        // If using dual tabs, send back the result
        if (this.tabMode) {
          this.tabListenerActive = true; // resume processing input data
          hermes.send('sign-remote', [this.blockHash, this.outputMultisigData]);
        }
      }
      this.wasm.musig_free(outPtr);
    }
  }
  // END MULTISIG
}
