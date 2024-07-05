/**
 * <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px"}}>
 *  <p style={{fontWeight: "normal"}}>Official <a href="https://dgraph.io/docs">Dgraph</a> adapter for Auth.js / NextAuth.js.</p>
 *  <a href="https://dgraph.io/">
 *   <img style={{display: "block"}} src="https://authjs.dev/img/adapters/dgraph.svg" width="100"/>
 *  </a>
 * </div>
 *
 * ## Installation
 *
 * ```bash npm2yarn
 * npm install next-auth @auth/dgraph-adapter
 * ```
 *
 * @module @auth/dgraph-adapter
 */
import { client as dgraphClient } from "./lib/client.js"
import type { DgraphClientParams } from "./lib/client.js"
import * as defaultFragments from "./lib/graphql/fragments.js"
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "@auth/core/adapters"

export type { DgraphClientParams, DgraphClientError } from "./lib/client.js"

/** This is the interface of the Dgraph adapter options. */
export interface DgraphAdapterOptions {
  /**
   * The GraphQL {@link https://dgraph.io/docs/query-language/fragments/ Fragments} you can supply to the adapter
   * to define how the shapes of the `user`, `account`, `session`, `verificationToken` entities look.
   *
   * By default the adapter will uses the [default defined fragments](https://github.com/nextauthjs/next-auth/blob/main/packages/adapter-dgraph/src/lib/graphql/fragments.ts)
   * , this config option allows to extend them.
   */
  fragments?: {
    User?: string
    Account?: string
    Session?: string
    VerificationToken?: string
  }
}

export function DgraphAdapter(
  client: DgraphClientParams,
  options?: DgraphAdapterOptions
): Adapter {
  const c = dgraphClient(client)
  const fragments = { ...defaultFragments, ...options?.fragments }

  return {
    async createUser(user: AdapterUser) {
      // Remove the id from the user object so that it can be generated by Dgraph
      const { id, ...userWithoutId } = user
      const result = await c.run<{ user: AdapterUser[] }>(
        /* GraphQL */ `
          mutation ($input: [AddUserInput!]!) {
            addUser(input: $input) {
              user {
                ...UserFragment
              }
            }
          }
          ${fragments.User}
        `,
        { input: [userWithoutId] }
      )

      if (!result || !result.user) {
        throw new Error("Failed to create user")
      }

      return result.user[0]
    },

    async getUser(id: string) {
      return await c.run<AdapterUser>(
        /* GraphQL */ `
          query ($id: ID!) {
            getUser(id: $id) {
              ...UserFragment
            }
          }
          ${fragments.User}
        `,
        { id }
      )
    },

    async getUserByEmail(email: string) {
      const result = await c.run<{ user: AdapterUser[] }>(
        /* GraphQL */ `
          query ($email: String!) {
            queryUser(filter: { email: { eq: $email } }) {
              ...UserFragment
            }
          }
          ${fragments.User}
        `,
        { email }
      )
      return result?.user?.[0] || null
    },

    async getUserByAccount({
      provider,
      providerAccountId,
    }: {
      provider: string
      providerAccountId: string
    }) {
      const result = await c.run<{ user: AdapterUser }[]>(
        /* GraphQL */ `
          query ($providerAccountId: String!, $provider: String!) {
            queryAccount(
              filter: {
                and: [
                  { providerAccountId: { eq: $providerAccountId } }
                  { provider: { eq: $provider } }
                ]
              }
            ) {
              user {
                ...UserFragment
              }
            }
          }
          ${fragments.User}
        `,
        { providerAccountId, provider }
      )
      return result?.[0]?.user || null
    },

    async updateUser(
      user: Partial<AdapterUser> & { id: string }
    ) {
      const { id, ...update } = user
      const result = await c.run<{ user: AdapterUser[] }>(
        /* GraphQL */ `
          mutation ($id: ID!, $input: UserPatch!) {
            updateUser(input: { filter: { id: [$id] }, set: $input }) {
              user {
                ...UserFragment
              }
            }
          }
          ${fragments.User}
        `,
        { id, input: update }
      )

      if (!result?.user?.[0]) {
        throw new Error("Failed to update user")
      }

      return result.user[0]
    },

    async deleteUser(userId: string) {
      const fetchResult = await c.run<{
        user: (AdapterUser & {
          accounts: { id: string }[]
          sessions: { sessionToken: string }[]
        })[]
      }>(
        /* GraphQL */ `
          query ($userId: ID!) {
            getUser(id: $userId) {
              ...UserFragment
              accounts {
                id
              }
              sessions {
                sessionToken
              }
            }
          }
          ${fragments.User}
        `,
        { userId }
      )

      const user = fetchResult?.user?.[0]
      if (!user) {
        return null // User not found
      }

      const deleteResult = await c.run<{ user: AdapterUser[] }>(
        /* GraphQL */ `
          mutation ($userId: [ID!]!) {
            deleteUser(filter: { id: $userId }) {
              user {
                ...UserFragment
              }
            }
          }
          ${fragments.User}
        `,
        { userId: [userId] }
      )

      const deletedUser = deleteResult?.user?.[0]
      if (!deletedUser) {
        throw new Error("Failed to delete user")
      }

      if (user.accounts.length > 0 || user.sessions.length > 0) {
        await c.run<{
          deleteAccount: { numUids: number }
          deleteSession: { numUids: number }
        }>(
          /* GraphQL */ `
            mutation ($accountIds: [ID!], $sessionTokens: [String!]) {
              deleteAccount(filter: { id: $accountIds }) {
                numUids
              }
              deleteSession(filter: { sessionToken: $sessionTokens }) {
                numUids
              }
            }
          `,
          {
            accountIds: user.accounts.map((x) => x.id),
            sessionTokens: user.sessions.map((x) => x.sessionToken),
          }
        )
      }

      return deletedUser
    },

    async linkAccount(account: AdapterAccount) {
      const { id, userId, ...inputWithoutId } = account
      const result = await c.run<{ account: AdapterAccount[] }>(
        /* GraphQL */ `
          mutation ($input: [AddAccountInput!]!) {
            addAccount(input: $input) {
              account {
                ...AccountFragment
              }
            }
          }
          ${fragments.Account}
        `,
        { input: [{ ...inputWithoutId, user: { id: userId } }] }
      )

      if (!result?.account?.[0]) {
        throw new Error("Failed to link account")
      }

      return result.account[0]
    },

    async unlinkAccount(
      account: Pick<AdapterAccount, "provider" | "providerAccountId">
    ) {
      const { provider, providerAccountId } = account
      const result = await c.run<{ account: AdapterAccount[] }>(
        /* GraphQL */ `
          mutation ($providerAccountId: String!, $provider: String!) {
            deleteAccount(
              filter: {
                and: [
                  { providerAccountId: { eq: $providerAccountId } }
                  { provider: { eq: $provider } }
                ]
              }
            ) {
              account {
                ...AccountFragment
              }
            }
          }
          ${fragments.Account}
        `,
        { providerAccountId, provider }
      )

      return result?.account?.[0]
    },

    async getSessionAndUser(
      sessionToken: string
    ) {
      const result = await c.run<{
        getSessionAndUser: {
          session: AdapterSession
          user: AdapterUser
        }[]
      }>(
        /* GraphQL */ `
          query GetSessionAndUser($sessionToken: String!) {
            getSessionAndUser(filter: { sessionToken: { eq: $sessionToken } }) {
              session {
                ...SessionFragment
              }
              user {
                ...UserFragment
              }
            }
          }
          ${fragments.Session}
          ${fragments.User}
        `,
        { sessionToken }
      )

      const sessionAndUser = result?.getSessionAndUser?.[0]
      if (!sessionAndUser || !sessionAndUser.user || !sessionAndUser.session) {
        return null
      }

      return sessionAndUser
    },

    async createSession({
      sessionToken,
      userId,
      expires,
    }: AdapterSession) {
      if (userId === undefined) {
        throw new Error("userId is undefined in createSession")
      }

      const result = await c.run<{ session: AdapterSession[] }>(
        /* GraphQL */ `
          mutation CreateSession($input: [AddSessionInput!]!) {
            addSession(input: $input) {
              session {
                ...SessionFragment
              }
            }
          }
          ${fragments.Session}
        `,
        { input: [{ sessionToken, expires, user: { id: userId } }] }
      )

      if (!result?.session?.[0]) {
        throw new Error("Failed to create session")
      }

      return result.session[0]
    },

    async deleteSession(
      sessionToken: string
    ) {
      const result = await c.run<{ session: AdapterSession[] }>(
        /* GraphQL */ `
          mutation DeleteSession($sessionToken: String!) {
            deleteSession(filter: { sessionToken: { eq: $sessionToken } }) {
              session {
                ...SessionFragment
              }
            }
          }
          ${fragments.Session}
        `,
        { sessionToken }
      )

      return result?.session?.[0] || null
    },

    async createVerificationToken(
      input: VerificationToken
    ) {
      const result = await c.run<{
        verificationToken: VerificationToken[]
      }>(
        /* GraphQL */ `
          mutation CreateVerificationToken(
            $input: [AddVerificationTokenInput!]!
          ) {
            addVerificationToken(input: $input) {
              verificationToken {
                identifier
                token
                expires
              }
            }
          }
        `,
        { input: [input] }
      )

      const createdToken = result?.verificationToken?.[0]
      if (!createdToken) {
        throw new Error("Failed to create verification token")
      }

      return createdToken
    },

    async useVerificationToken(params: {
      identifier: string
      token: string
    }) {
      const result = await c.run<{
        verificationToken: VerificationToken[]
      }>(
        /* GraphQL */ `
          mutation UseVerificationToken($token: String!, $identifier: String!) {
            deleteVerificationToken(
              filter: {
                and: [
                  { token: { eq: $token } }
                  { identifier: { eq: $identifier } }
                ]
              }
            ) {
              verificationToken {
                ...VerificationTokenFragment
              }
            }
          }
          ${fragments.VerificationToken}
        `,
        params
      )

      return result?.verificationToken?.[0] || null
    },
  }
}
