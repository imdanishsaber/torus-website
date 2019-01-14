const EventEmitter = require('events')
const ComposableObservableStore = require('./ComposableObservableStore')
const log = require('loglevel')
const EthQuery = require('eth-query')
const pify = require('pify')
const nodeify = require('nodeify')
const NetworkController = require('./NetworkController')
const AccountTracker = require('./AccountTracker')
const TransactionController = require('./TransactionController')

// defaults and constants
const version = '0.0.1'

module.exports = class TorusController extends EventEmitter {
  /**
   * @constructor
   * @param {Object} opts
   */
  constructor (opts) {
    super()
    this.defaultMaxListeners = 20
    this.opts = opts
    this.store = ComposableObservableStore()
    this.networkController = new NetworkController()
    this.initializeProvider()
    this.provider = this.networkController.getProviderAndBlockTracker().provider
    this.blockTracker = this.networkController.getProviderAndBlockTracker().blockTracker
    this.accountTracker = new AccountTracker({
      provider: this.provider,
      blockTracker: this.blockTracker
    })
    // start and stop polling for balances based on activeControllerConnections
    this.on('controllerConnectionChanged', (activeControllerConnections) => {
      if (activeControllerConnections > 0) {
        this.accountTracker.start()
      } else {
        this.accountTracker.stop()
      }
    })
    // tx mgmt
    this.txController = new TransactionController({
      initState: initState.TransactionController || initState.TransactionManager,
      networkStore: this.networkController.networkStore,
      preferencesStore: this.preferencesController.store,
      txHistoryLimit: 40,
      getNetwork: this.networkController.getNetworkState.bind(this),
      signTransaction: () => {
        
      },
      provider: this.provider,
      blockTracker: this.blockTracker,
      getGasPrice: this.getGasPrice.bind(this),
    })
    this.txController.on('newUnapprovedTx', () => opts.showUnapprovedTx())

    this.txController.on(`tx:status-update`, (txId, status) => {
      if (status === 'confirmed' || status === 'failed') {
        const txMeta = this.txController.txStateManager.getTx(txId)
        this.platform.showTransactionNotification(txMeta)
      }
    })
  }

  /**
   * Helper method for initializing provider
   */
  initializeProvider () {
    const providerOpts = {
      static: {
        eth_syncing: false,
        web3_clientVersion: `Torus/v${version}`
      },
      version,
      // account mgmt
      getAccounts: async ({ origin }) => {
        // Expose no accounts if this origin has not been approved, preventing
        // account-requring RPC methods from completing successfully
        const exposeAccounts = this.providerApprovalController.shouldExposeAccounts(origin)
        if (origin !== 'MetaMask' && !exposeAccounts) { return [] }
        const isUnlocked = this.keyringController.memStore.getState().isUnlocked
        const selectedAddress = this.preferencesController.getSelectedAddress()
        // only show address if account is unlocked
        if (isUnlocked && selectedAddress) {
          return [selectedAddress]
        } else {
          return []
        }
      },
      // tx signing
      processTransaction: this.newUnapprovedTransaction.bind(this),
      // msg signing
      processEthSignMessage: this.newUnsignedMessage.bind(this),
      processTypedMessage: this.newUnsignedTypedMessage.bind(this),
      processTypedMessageV3: this.newUnsignedTypedMessage.bind(this),
      processPersonalMessage: this.newUnsignedPersonalMessage.bind(this),
      getPendingNonce: this.getPendingNonce.bind(this)
    }
    const providerProxy = this.networkController.initializeProvider(providerOpts)
    return providerProxy
  }

  /**
   * Returns internal state of the TorusController
   *
   * @returns {Object} status
   */
  getState () {
    return this.store.getFlatState()
  }

  /**
   * Get an account balance from the AccountTracker or request it directly from the network.
   * @param {string} address - The account address
   * @param {EthQuery} ethQuery - The EthQuery instance to use when asking the network
   */
  getBalance (address) {
    return new Promise((resolve, reject) => {
      const ethQuery = EthQuery(this.provider)
      const cached = this.accountTracker.store.getState().accounts[address]

      if (cached && cached.balance) {
        resolve(cached.balance)
      } else {
        ethQuery.getBalance(address, (error, balance) => {
          if (error) {
            reject(error)
            log.error(error)
          } else {
            resolve(balance || '0x0')
          }
        })
      }
    })
  }

  /**
   * A method for estimating a good gas price at recent prices.
   * Returns the lowest price that would have been included in
   * 50% of recent blocks.
   *
   * @returns {string} A hex representation of the suggested wei gas price.
   */
  getGasPrice () {
    const { recentBlocksController } = this
    const { recentBlocks } = recentBlocksController.store.getState()

    // Return 1 gwei if no blocks have been observed:
    if (recentBlocks.length === 0) {
      return '0x' + GWEI_BN.toString(16)
    }

    const lowestPrices = recentBlocks.map((block) => {
      if (!block.gasPrices || block.gasPrices.length < 1) {
        return GWEI_BN
      }
      return block.gasPrices
        .map(hexPrefix => hexPrefix.substr(2))
        .map(hex => new BN(hex, 16))
        .sort((a, b) => {
          return a.gt(b) ? 1 : -1
        })[0]
    }).map(number => number.div(GWEI_BN).toNumber())

    const percentileNum = percentile(65, lowestPrices)
    const percentileNumBn = new BN(percentileNum)
    return '0x' + percentileNumBn.mul(GWEI_BN).toString(16)
  }

  /**
   * Called when a Dapp suggests a new tx to be signed.
   * this wrapper needs to exist so we can provide a reference to
   *  "newUnapprovedTransaction" before "txController" is instantiated
   *
   * @param {Object} msgParams - The params passed to eth_sign.
   * @param {Object} req - (optional) the original request, containing the origin
   */
  async newUnapprovedTransaction (txParams, req) {
    return await this.txController.newUnapprovedTransaction(txParams, req)
  }

  // eth_sign methods:

  /**
   * Called when a Dapp uses the eth_sign method, to request user approval.
   * eth_sign is a pure signature of arbitrary data. It is on a deprecation
   * path, since this data can be a transaction, or can leak private key
   * information.
   *
   * @param {Object} msgParams - The params passed to eth_sign.
   * @param {Function} cb = The callback function called with the signature.
   */
  newUnsignedMessage (msgParams, req) {
    const promise = this.messageManager.addUnapprovedMessageAsync(msgParams, req)
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * Signifies user intent to complete an eth_sign method.
   *
   * @param  {Object} msgParams The params passed to eth_call.
   * @returns {Promise<Object>} Full state update.
   */
  signMessage (msgParams) {
    log.info('MetaMaskController - signMessage')
    const msgId = msgParams.metamaskId

    // sets the status op the message to 'approved'
    // and removes the metamaskId for signing
    return this.messageManager.approveMessage(msgParams)
      .then((cleanMsgParams) => {
      // signs the message
        return this.keyringController.signMessage(cleanMsgParams)
      })
      .then((rawSig) => {
      // tells the listener that the message has been signed
      // and can be returned to the dapp
        this.messageManager.setMsgStatusSigned(msgId, rawSig)
        return this.getState()
      })
  }

  /**
   * Used to cancel a message submitted via eth_sign.
   *
   * @param {string} msgId - The id of the message to cancel.
   */
  cancelMessage (msgId, cb) {
    const messageManager = this.messageManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  // personal_sign methods:

  /**
   * Called when a dapp uses the personal_sign method.
   * This is identical to the Geth eth_sign method, and may eventually replace
   * eth_sign.
   *
   * We currently define our eth_sign and personal_sign mostly for legacy Dapps.
   *
   * @param {Object} msgParams - The params of the message to sign & return to the Dapp.
   * @param {Function} cb - The callback function called with the signature.
   * Passed back to the requesting Dapp.
   */
  async newUnsignedPersonalMessage (msgParams, req) {
    const promise = this.personalMessageManager.addUnapprovedMessageAsync(msgParams, req)
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * Signifies a user's approval to sign a personal_sign message in queue.
   * Triggers signing, and the callback function from newUnsignedPersonalMessage.
   *
   * @param {Object} msgParams - The params of the message to sign & return to the Dapp.
   * @returns {Promise<Object>} - A full state update.
   */
  signPersonalMessage (msgParams) {
    log.info('MetaMaskController - signPersonalMessage')
    const msgId = msgParams.metamaskId
    // sets the status op the message to 'approved'
    // and removes the metamaskId for signing
    return this.personalMessageManager.approveMessage(msgParams)
      .then((cleanMsgParams) => {
        // signs the message
        return this.keyringController.signPersonalMessage(cleanMsgParams)
      })
      .then((rawSig) => {
        // tells the listener that the message has been signed
        // and can be returned to the dapp
        this.personalMessageManager.setMsgStatusSigned(msgId, rawSig)
        return this.getState()
      })
  }

  /**
   * Used to cancel a personal_sign type message.
   * @param {string} msgId - The ID of the message to cancel.
   * @param {Function} cb - The callback function called with a full state update.
   */
  cancelPersonalMessage (msgId, cb) {
    const messageManager = this.personalMessageManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  // eth_signTypedData methods

  /**
   * Called when a dapp uses the eth_signTypedData method, per EIP 712.
   *
   * @param {Object} msgParams - The params passed to eth_signTypedData.
   * @param {Function} cb - The callback function, called with the signature.
   */
  newUnsignedTypedMessage (msgParams, req, version) {
    const promise = this.typedMessageManager.addUnapprovedMessageAsync(msgParams, req, version)
    this.sendUpdate()
    this.opts.showUnconfirmedMessage()
    return promise
  }

  /**
   * The method for a user approving a call to eth_signTypedData, per EIP 712.
   * Triggers the callback in newUnsignedTypedMessage.
   *
   * @param  {Object} msgParams - The params passed to eth_signTypedData.
   * @returns {Object} Full state update.
   */
  async signTypedMessage (msgParams) {
    log.info('MetaMaskController - eth_signTypedData')
    const msgId = msgParams.metamaskId
    const version = msgParams.version
    try {
      const cleanMsgParams = await this.typedMessageManager.approveMessage(msgParams)
      const address = sigUtil.normalize(cleanMsgParams.from)
      const keyring = await this.keyringController.getKeyringForAccount(address)
      let signature
      // HW Wallet keyrings don't expose private keys
      // so we need to handle it separately
      if (!HW_WALLETS_KEYRINGS.includes(keyring.type)) {
        const wallet = keyring._getWalletForAccount(address)
        const privKey = ethUtil.toBuffer(wallet.getPrivateKey())
        switch (version) {
          case 'V1':
            signature = sigUtil.signTypedDataLegacy(privKey, { data: cleanMsgParams.data })
            break
          case 'V3':
            signature = sigUtil.signTypedData(privKey, { data: JSON.parse(cleanMsgParams.data) })
            break
        }
      } else {
        signature = await keyring.signTypedData(address, cleanMsgParams.data)
      }
      this.typedMessageManager.setMsgStatusSigned(msgId, signature)
      return this.getState()
    } catch (error) {
      log.info('MetaMaskController - eth_signTypedData failed.', error)
      this.typedMessageManager.errorMessage(msgId, error)
    }
  }

  /**
   * Used to cancel a eth_signTypedData type message.
   * @param {string} msgId - The ID of the message to cancel.
   * @param {Function} cb - The callback function called with a full state update.
   */
  cancelTypedMessage (msgId, cb) {
    const messageManager = this.typedMessageManager
    messageManager.rejectMsg(msgId)
    if (cb && typeof cb === 'function') {
      cb(null, this.getState())
    }
  }

  /**
   * Used to estimate gas of a transaction
   * @param {Object} estimateGasParams - estimate gas parameters
   */
  estimateGas (estimateGasParams) {
    return new Promise((resolve, reject) => {
      return this.txController.txGasUtil.query.estimateGas(estimateGasParams, (err, res) => {
        if (err) {
          return reject(err)
        }

        return resolve(res)
      })
    })
  }

  /**
   * Used to create a multiplexed stream for connecting to an untrusted context
   * like a Dapp or other extension.
   * @param {*} connectionStream - The Duplex stream to connect to.
   * @param {string} originDomain - The domain requesting the stream, which
   * may trigger a blacklist reload.
   */
  setupUntrustedCommunication (connectionStream, originDomain) {
    // setup multiplexing
    const mux = setupMultiplex(connectionStream)
    // connect features
    this.setupProviderConnection(mux.createStream('provider'), originDomain)
    this.setupPublicConfig(mux.createStream('publicConfig'))
  }

  /**
   * Used to create a multiplexed stream for connecting to a trusted context,
   * like our own user interfaces, which have the provider APIs, but also
   * receive the exported API from this controller, which includes trusted
   * functions, like the ability to approve transactions or sign messages.
   *
   * @param {*} connectionStream - The duplex stream to connect to.
   * @param {string} originDomain - The domain requesting the connection,
   * used in logging and error reporting.
   */
  setupTrustedCommunication (connectionStream, originDomain) {
    // setup multiplexing
    const mux = setupMultiplex(connectionStream)
    // connect features
    this.setupControllerConnection(mux.createStream('controller'))
    this.setupProviderConnection(mux.createStream('provider'), originDomain)
  }

  /**
   * A method for providing our API over a stream using Dnode.
   * @param {*} outStream - The stream to provide our API over.
   */
  setupControllerConnection (outStream) {
    const api = this.getApi()
    const dnode = Dnode(api)
    // report new active controller connection
    this.activeControllerConnections++
    this.emit('controllerConnectionChanged', this.activeControllerConnections)
    // connect dnode api to remote connection
    pump(
      outStream,
      dnode,
      outStream,
      (err) => {
        // report new active controller connection
        this.activeControllerConnections--
        this.emit('controllerConnectionChanged', this.activeControllerConnections)
        // report any error
        if (err) log.error(err)
      }
    )
    dnode.on('remote', (remote) => {
      // push updates to popup
      const sendUpdate = (update) => remote.sendUpdate(update)
      this.on('update', sendUpdate)
      // remove update listener once the connection ends
      dnode.on('end', () => this.removeListener('update', sendUpdate))
    })
  }

  /**
   * A method for serving our ethereum provider over a given stream.
   * @param {*} outStream - The stream to provide over.
   * @param {string} origin - The URI of the requesting resource.
   */
  setupProviderConnection (outStream, origin) {
    // setup json rpc engine stack
    const engine = new RpcEngine()
    const provider = this.provider
    const blockTracker = this.blockTracker

    // create filter polyfill middleware
    const filterMiddleware = createFilterMiddleware({ provider, blockTracker })
    // create subscription polyfill middleware
    const subscriptionManager = createSubscriptionManager({ provider, blockTracker })
    subscriptionManager.events.on('notification', (message) => engine.emit('notification', message))

    // metadata
    engine.push(createOriginMiddleware({ origin }))
    engine.push(createLoggerMiddleware({ origin }))
    // filter and subscription polyfills
    engine.push(filterMiddleware)
    engine.push(subscriptionManager.middleware)
    // watch asset
    engine.push(this.preferencesController.requestWatchAsset.bind(this.preferencesController))
    // forward to metamask primary provider
    engine.push(createProviderMiddleware({ provider }))

    // setup connection
    const providerStream = createEngineStream({ engine })

    pump(
      outStream,
      providerStream,
      outStream,
      (err) => {
        // cleanup filter polyfill middleware
        filterMiddleware.destroy()
        if (err) log.error(err)
      }
    )
  }

  /**
   * A method for providing our public config info over a stream.
   * This includes info we like to be synchronous if possible, like
   * the current selected account, and network ID.
   *
   * Since synchronous methods have been deprecated in web3,
   * this is a good candidate for deprecation.
   *
   * @param {*} outStream - The stream to provide public config over.
   */
  setupPublicConfig (outStream) {
    const configStream = asStream(this.publicConfigStore)
    pump(
      configStream,
      outStream,
      (err) => {
        configStream.destroy()
        if (err) log.error(err)
      }
    )
  }

  /**
   * A method for emitting the full MetaMask state to all registered listeners.
   * @private
   */
  privateSendUpdate () {
    this.emit('update', this.getState())
  }

  /**
   * Returns the nonce that will be associated with a transaction once approved
   * @param address {string} - The hex string address for the transaction
   * @returns Promise<number>
   */
  async getPendingNonce (address) {
    const { nonceDetails, releaseLock} = await this.txController.nonceTracker.getNonceLock(address)
    const pendingNonce = nonceDetails.params.highestSuggested

    releaseLock()
    return pendingNonce
  }
}
