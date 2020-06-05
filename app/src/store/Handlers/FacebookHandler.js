import { get } from '../../utils/httpHelpers'
import AbstractLoginHandler from './AbstractLoginHandler'

export default class FacebookHandler extends AbstractLoginHandler {
  RESPONSE_TYPE = 'token'

  SCOPE = 'public_profile email'

  constructor(_clientId, _verifier, _redirect_uri, _redirectToOpener) {
    super(_clientId, _verifier, _redirect_uri, _redirectToOpener)
    this.setFinalUrl()
  }

  setFinalUrl() {
    const finalUrl = new URL('https://www.facebook.com/v6.0/dialog/oauth')
    finalUrl.searchParams.append('response_type', this.RESPONSE_TYPE)
    finalUrl.searchParams.append('client_id', this.clientId)
    finalUrl.searchParams.append('state', this.state)
    finalUrl.searchParams.append('scope', this.SCOPE)
    finalUrl.searchParams.append('redirect_uri', this.redirect_uri)
    this.finalURL = finalUrl
  }

  async getUserInfo(parameters) {
    const { accessToken } = parameters
    const userInfo = await get('https://graph.facebook.com/me?fields=name,email,picture.type(large)', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
    const { name = '', id, picture, email = '' } = userInfo
    return {
      email,
      name,
      profileImage: picture.data.url || '',
      verifier: this.verifier,
      verifierId: id,
    }
  }
}
