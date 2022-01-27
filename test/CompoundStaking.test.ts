import { waffle, ethers } from "hardhat"
import { expect } from "chai"
import { BigNumber, BigNumberish, constants, Contract, Wallet } from 'ethers'
import { compoundFixture } from "./utilities/fixtures"
import { mineBlocks, setTimestamp, expandTo18Decimals, time } from "./utilities/index"

import { ERC20 } from "../types/ERC20"
import { CompoundStaking } from "../types/CompoundStaking"



describe("Compound", () => {
    const [wallet, admin0, admin1, alice, bob, denice, fedor, other] = waffle.provider.getWallets()

    let loadFixture: ReturnType<typeof waffle.createFixtureLoader>

    before("create fixture loader", async () => {
        loadFixture = waffle.createFixtureLoader([wallet, admin0, admin1, other], waffle.provider)
    })

    let gton: ERC20
    let compound: CompoundStaking
    beforeEach("deploy test contracts", async () => {
        ; ({
            gton,
            compound,
        } = await loadFixture(compoundFixture))

    })

    const calcDecimals = BigNumber.from(1e12);

    async function fillUpCompound() {
        const fedorValue = BigNumber.from("974426000000")
        const deniceValue = BigNumber.from("1000000")
        const bobValue = BigNumber.from("76499200000")

        await gton.transfer(denice.address, deniceValue)
        await gton.connect(denice).approve(compound.address, deniceValue)
        await compound.connect(denice).mint(deniceValue, denice.address)

        await gton.transfer(fedor.address, fedorValue)
        await gton.connect(fedor).approve(compound.address, fedorValue)
        await compound.connect(fedor).mint(fedorValue, fedor.address)

        await gton.transfer(bob.address, bobValue)
        await gton.connect(bob).approve(compound.address, bobValue)
        await compound.connect(bob).mint(bobValue, bob.address)
    }

    it("constructor initializes variables", async () => {
        const lastBlock = (await waffle.provider.getBlock("latest")).timestamp
        expect(await compound.owner()).to.eq(wallet.address)
        expect(await compound.totalAmounts()).to.eq(0)
        expect(await compound.harvestInterval()).to.eq(86400)
        expect(await compound.accumulatedRewardPerShare()).to.eq(0)
        expect(await compound.decimals()).to.eq(await gton.decimals())
        expect(await compound.lastRewardTimestamp()).to.eq(lastBlock)
        const admins = [await compound.admins(0), await compound.admins(1)]
        expect(admins).to.have.members([admin0.address, admin1.address])
    })

    it("transfer ownership", async () => {
        await expect(compound.connect(other).transferOwnership(wallet.address)).to.be.revertedWith('Compound: permitted to owner only.')
        await compound.transferOwnership(other.address)
        expect(await compound.owner()).to.eq(other.address)
    })

    it("setAdmins", async () => {
        await expect(compound.connect(other).setAdmins([alice.address, bob.address])).to.be.revertedWith('Compound: permitted to owner only.')
        // expect admin to fail to setAdmins
        await expect(compound.connect(admin0).setAdmins([alice.address, bob.address])).to.be.revertedWith('Compound: permitted to owner only.')
        await compound.setAdmins([alice.address, bob.address]);
        // 0 and 1 indicies are for admin0 and admin1
        expect(await compound.admins(2)).to.eq(alice.address);
        expect(await compound.admins(3)).to.eq(bob.address);
    })

    it("removeAdmins", async () => {
        await compound.setAdmins([alice.address, bob.address, other.address]);
        // expect admin to fail to removeAdmins
        await expect(compound.connect(admin0).removeAdmins([admin0.address])).to.be.revertedWith('Compound: permitted to owner only.')
        // 0 and 1 indicies are for admin0 and admin1
        expect(await compound.admins(2)).to.eq(alice.address);
        expect(await compound.admins(3)).to.eq(bob.address);
        await compound.removeAdmins([alice.address, other.address]);
        expect(await compound.admins(2)).to.eq(bob.address);
        await expect(compound.admins(3)).to.be.reverted;
    })

    it("set apys", async () => {
        // random numbers
        const apyNominator = BigNumber.from("140")
        const apyDenominator = BigNumber.from("13")
        await expect(compound.connect(other).setApy(apyNominator, apyDenominator)).to.be.revertedWith('Compound: permitted to admins only.')
        await compound.setApy(apyNominator, apyDenominator)
        expect(await compound.apyNominator()).to.eq(apyNominator)
        expect(await compound.apyDenominator()).to.eq(apyDenominator)

        const apyNominatorAdmin = BigNumber.from("5977")
        const apyDenominatorAdmin = BigNumber.from("854")
        await compound.connect(admin0).setApy(apyNominatorAdmin, apyDenominatorAdmin)
        expect(await compound.apyNominator()).to.eq(apyNominatorAdmin)
        expect(await compound.apyDenominator()).to.eq(apyDenominatorAdmin)
    })

    it("withdraw token", async () => {
        const amount = BigNumber.from(15000000000000)
        gton.transfer(compound.address, amount)
        await expect(compound.connect(other).withdrawToken(gton.address, wallet.address, amount)).to.be.revertedWith('Compound: permitted to owner only')
        // expect admin to fail to withdraw
        await expect(compound.connect(admin0).withdrawToken(gton.address, wallet.address, amount)).to.be.revertedWith('Compound: permitted to owner only')
        await compound.withdrawToken(gton.address, other.address, amount)
        expect(await gton.balanceOf(other.address)).to.eq(amount)
        expect(await gton.balanceOf(compound.address)).to.eq(0)
        await expect(compound.withdrawToken(gton.address, other.address, amount.add(1))).to.be.reverted
    })
    const updRewardData = [
        {
            period: 100,
            apyNominator: BigNumber.from("120000000"),
            apyDenominator: BigNumber.from("1000000000"),
            amount: expandTo18Decimals(150),
            user: bob,
        },
        {
            period: 1000,
            apyNominator: BigNumber.from("7500000"),
            apyDenominator: BigNumber.from("10000000"),
            amount: expandTo18Decimals(897),
            user: alice,
        },
        {
            period: 5000,
            apyNominator: BigNumber.from("9000"),
            apyDenominator: BigNumber.from("100000"),
            amount: expandTo18Decimals(54000),
            user: other,
        },
    ]

    it("update reward pool", async () => {
        for (const item of updRewardData) {
            await compound.setApy(item.apyNominator, item.apyDenominator);
            const prevAccRewardPerShare = await compound.accumulatedRewardPerShare();
            const lastChangeTS = await compound.lastRewardTimestamp();
            await setTimestamp(waffle.provider, lastChangeTS.add(time.day).toNumber())
            await compound.updateRewardPool()
            const delta = (await compound.lastRewardTimestamp()).sub(lastChangeTS)
            const minted = calcDecimals.mul(delta).mul(item.apyNominator).div(item.apyDenominator).div(time.year)

            expect(await compound.accumulatedRewardPerShare()).to.eq(prevAccRewardPerShare.add(minted))
            expect(await compound.lastRewardTimestamp()).to.eq(lastChangeTS.add(time.day).add(1))
        }

        await compound.toggleRevert();
        await expect(compound.updateRewardPool()).to.be.revertedWith("Compound: reverted flag on.")
        await compound.toggleRevert();
    })
    async function updateDelta(sec: number = 1) {
        const apyD = await compound.apyDenominator();
        const apyN = await compound.apyNominator();
        const lastRewardTimestamp = await compound.lastRewardTimestamp()
        const currentBlockTS = (await waffle.provider.getBlock("latest")).timestamp
        const delta = BigNumber.from(currentBlockTS).add(sec).sub(lastRewardTimestamp)
        return calcDecimals.mul(delta).mul(apyN).div(apyD).div(time.year)
    }

    async function mint(forUser: string, amount: BigNumberish) {
        const beforeTotalAmount = await compound.totalAmounts()
        const beforeState = await compound.userInfo(forUser);
        const beforeAmount = beforeState.amount
        const accRewardPerShare = await compound.accumulatedRewardPerShare()
        const accPerShareBeforeShareUpdate = (accRewardPerShare).add(await updateDelta(2))
        const accPerShareAfterShareUpdate = accPerShareBeforeShareUpdate.mul(amount).div(calcDecimals)
        const rewardDebt = accPerShareBeforeShareUpdate.mul(beforeState.amount.add(amount)).div(calcDecimals)
        await gton.approve(compound.address, amount);
        await compound.mint(amount, forUser)
        const res = await compound.userInfo(forUser)

        expect(res.amount).to.eq(beforeAmount.add(amount))
        expect(res.rewardDebt).to.eq(rewardDebt)
        expect(res.accumulatedReward).to.eq(beforeAmount.gt(0) ? accPerShareAfterShareUpdate : 0) // imposiible to have reward right after mint
        expect(await compound.accumulatedRewardPerShare()).to.eq(accPerShareBeforeShareUpdate)
        expect(await compound.totalAmounts()).to.eq(beforeTotalAmount.add(amount))
    }

    it("mint", async () => {
        const amount = expandTo18Decimals(256)

        await expect(compound.mint(0, wallet.address)).to.be.revertedWith("Compound: Nothing to deposit")
        await expect(compound.mint(amount, wallet.address)).to.be.revertedWith("ERC20: transfer amount exceeds allowance")

        await compound.toggleRevert();
        await expect(compound.mint(amount, wallet.address)).to.be.revertedWith("Compound: reverted flag on.")
        await compound.toggleRevert();
        await mint(wallet.address, amount)

        await fillUpCompound();

        const amount2 = expandTo18Decimals(150)
        await mint(other.address, amount2)
    })

    async function burn(user: Wallet, amount: BigNumberish) {
        const totalAmountsBefore = await compound.totalAmounts()
        const currentAccRewPerShare = await compound.accumulatedRewardPerShare()
        const stateBefore = await compound.userInfo(user.address);

        const updateARPS = await updateDelta()
        const rewardEarn = currentAccRewPerShare.add(updateARPS).mul(stateBefore.amount).div(calcDecimals).sub(stateBefore.rewardDebt);
        const rewardDebt = currentAccRewPerShare.add(updateARPS).mul(stateBefore.amount.sub(amount)).div(calcDecimals);

        await compound.connect(user).burn(user.address, amount)

        const state = await compound.userInfo(user.address)
        expect(state.amount).to.eq(stateBefore.amount.sub(amount))
        expect(state.accumulatedReward).to.eq(stateBefore.accumulatedReward.add(rewardEarn))
        expect(state.rewardDebt).to.eq(rewardDebt)
        expect(await compound.totalAmounts()).to.eq(totalAmountsBefore.sub(amount))
        expect(await compound.accumulatedRewardPerShare()).to.eq(currentAccRewPerShare.add(updateARPS))
    }
    it("burn", async () => {
        await fillUpCompound();

        const amount = expandTo18Decimals(115)
        const period = 50
        await gton.approve(compound.address, amount)

        await compound.mint(amount, wallet.address)
        await mineBlocks(waffle.provider, period)
        await expect(compound.burn(wallet.address, 0)).to.be.revertedWith("Compound: Nothing to burn")
        await expect(compound.burn(wallet.address, amount.add(1))).to.be.revertedWith("Compound: Insufficient share")

        await compound.toggleRevert();
        await expect(compound.burn(wallet.address, amount)).to.be.revertedWith("Compound: reverted flag on.")
        await compound.toggleRevert();

        await gton.transfer(compound.address, await gton.balanceOf(wallet.address));

        await burn(wallet, amount.sub(15))

    })

    it("harvest", async () => {
        await fillUpCompound();

        const amount = expandTo18Decimals(115)
        const period = 50
        await gton.approve(compound.address, amount)

        await compound.mint(amount, wallet.address)
        await mineBlocks(waffle.provider, period)
        await expect(compound.burn(wallet.address, 0)).to.be.revertedWith("Compound: Nothing to burn")
        await expect(compound.burn(wallet.address, amount.add(1))).to.be.revertedWith("Compound: Insufficient share")

        await compound.toggleRevert();
        await expect(compound.burn(wallet.address, amount)).to.be.revertedWith("Compound: reverted flag on.")
        await compound.toggleRevert();

        await gton.transfer(compound.address, await gton.balanceOf(wallet.address));

        await burn(wallet, amount.sub(15))

    })

    async function transfer(sender: Wallet, receiver: string, amount: BigNumberish) {
        const ARPS = await compound.accumulatedRewardPerShare()
        const updateARPS = (await updateDelta()).add(ARPS);

        const senderStateBefore = await compound.userInfo(sender.address)
        const receiverStateBefore = await compound.userInfo(receiver)

        const updSenderAmount = senderStateBefore.amount.sub(amount)
        const updSenderAcc = updateARPS.mul(senderStateBefore.amount).div(calcDecimals).sub(senderStateBefore.rewardDebt)
        const updSenderRewardDebt = updateARPS.mul(updSenderAmount).div(calcDecimals)
        const updReceiverAmount = receiverStateBefore.amount.add(amount)
        const updReceiverAcc = updateARPS.mul(receiverStateBefore.amount).div(calcDecimals).sub(receiverStateBefore.rewardDebt)
        const updReceiverRewardDebt = updateARPS.mul(updReceiverAmount).div(calcDecimals)


        await compound.connect(sender).transfer(receiver, amount)

        const senderStateAfter = await compound.userInfo(sender.address)
        const receiverStateAfter = await compound.userInfo(receiver)

        expect(senderStateAfter.amount).to.eq(updSenderAmount)
        expect(receiverStateAfter.amount).to.eq(updReceiverAmount)

        expect(senderStateAfter.accumulatedReward).to.eq(updSenderAcc)
        expect(receiverStateAfter.accumulatedReward).to.eq(updReceiverAcc)

        expect(senderStateAfter.rewardDebt).to.eq(updSenderRewardDebt)
        expect(receiverStateAfter.rewardDebt).to.eq(updReceiverRewardDebt)
    }

    it("transfer", async () => {
        const amount = expandTo18Decimals(279)
        await gton.approve(compound.address, amount);
        await compound.mint(amount, wallet.address)
        await mineBlocks(waffle.provider, 10)
        const balance = await compound.balanceOf(wallet.address)
        await expect(compound.transfer(other.address, balance.add(expandTo18Decimals(100)))).to.be.revertedWith("ERC20: transfer amount exceeds balance")

        await compound.toggleRevert();
        await expect(compound.transfer(other.address, balance)).to.be.revertedWith("Compound: reverted flag on.")
        await compound.toggleRevert();

        await transfer(wallet, other.address, amount.sub(65))
    })

    it("approve and allowance", async () => {
        const amount = BigNumber.from("10012412401248")
        const secondAmount = BigNumber.from("1000000")
        expect(await compound.allowance(wallet.address, bob.address)).to.eq(0)

        await compound.toggleRevert();
        await expect(compound.approve(alice.address, amount)).to.be.revertedWith("Compound: reverted flag on.")
        await compound.toggleRevert();

        // await expect(compound.approve(wallet.address, 0)).to.be.revertedWith("ERC20: approve to the zero address")
        await compound.approve(alice.address, amount)
        expect(await compound.allowance(wallet.address, alice.address)).to.eq(amount)
        await compound.approve(alice.address, secondAmount)
        expect(await compound.allowance(wallet.address, alice.address)).to.eq(secondAmount)
    })

    it("transferFrom", async () => {
        const amount = expandTo18Decimals(150)
        await gton.approve(compound.address, amount);
        await compound.mint(amount, wallet.address)

        await mineBlocks(waffle.provider, 10)
        await expect(compound.connect(bob).transferFrom(wallet.address, bob.address, 15)).to.be.revertedWith("ERC20: transfer amount exceeds allowance")

        await compound.toggleRevert();
        await expect(compound.transferFrom(wallet.address, bob.address, 15)).to.be.revertedWith("Compound: reverted flag on.")
        await compound.toggleRevert();

        const transferAmount = (await compound.balanceOf(wallet.address)).div(2) // half of the amount
        await compound.approve(bob.address, transferAmount)

        const ARPS = await compound.accumulatedRewardPerShare()
        const updateARPS = (await updateDelta()).add(ARPS);

        const senderStateBefore = await compound.userInfo(wallet.address)
        const receiverStateBefore = await compound.userInfo(bob.address)

        const updSenderAmount = senderStateBefore.amount.sub(transferAmount)
        const updSenderAcc = updateARPS.mul(senderStateBefore.amount).div(calcDecimals).sub(senderStateBefore.rewardDebt)
        const updSenderRewardDebt = updateARPS.mul(updSenderAmount).div(calcDecimals)
        const updReceiverAmount = receiverStateBefore.amount.add(transferAmount)
        const updReceiverAcc = updateARPS.mul(receiverStateBefore.amount).div(calcDecimals).sub(receiverStateBefore.rewardDebt)
        const updReceiverRewardDebt = updateARPS.mul(updReceiverAmount).div(calcDecimals)

        await compound.connect(bob).transferFrom(wallet.address, bob.address, transferAmount)

        const senderStateAfter = await compound.userInfo(wallet.address)
        const receiverStateAfter = await compound.userInfo(bob.address)

        expect(senderStateAfter.amount).to.eq(updSenderAmount)
        expect(receiverStateAfter.amount).to.eq(updReceiverAmount)

        expect(senderStateAfter.accumulatedReward).to.eq(updSenderAcc)
        expect(receiverStateAfter.accumulatedReward).to.eq(updReceiverAcc)

        expect(senderStateAfter.rewardDebt).to.eq(updSenderRewardDebt)
        expect(receiverStateAfter.rewardDebt).to.eq(updReceiverRewardDebt)
    })

    context("Apy checking", function () {

        async function checkUserApy(user: Wallet, period: number, rounding: boolean = false) {
            const apyN = await compound.apyNominator()
            const apyD = await compound.apyDenominator()
            const userState = await compound.userInfo(user.address);
            const lastTS = BigNumber.from((await waffle.provider.getBlock("latest")).timestamp)
            const stake = userState.amount;
            const yearEarn = stake.mul(apyN).div(apyD);
            const earn = yearEarn.mul(period).div(time.year)
            const balanceBefore = await compound.balanceOf(user.address)
            await setTimestamp(waffle.provider, lastTS.add(period).toNumber())
            if(rounding) {
                expect(await compound.balanceOf(user.address)).to.be.closeTo(balanceBefore.add(earn), 100000000000) // because of 1 block
            } else {
                expect(await compound.balanceOf(user.address)).to.eq(balanceBefore.add(earn))
            }
        }

        it("After year APY of each user should be correct and APY of all sc the same", async () => {
            await fillUpCompound()
            for (const i of updRewardData) {
                await compound.setApy(i.apyNominator, i.apyDenominator)
                await gton.approve(compound.address, i.amount);
                await compound.mint(i.amount, i.user.address)
                await checkUserApy(i.user, time.year)
            }
        })

        it("After n blocks APY of all sc should be correct for these n blocks", async () => {
            await fillUpCompound()
            for (const period of Object.values(time)) {
                for (const i of updRewardData) {
                    await compound.setApy(i.apyNominator, i.apyDenominator)
                    await gton.approve(compound.address, i.amount);
                    await compound.mint(i.amount, i.user.address)
                    await checkUserApy(i.user, period, true)
                    // need to return back to save funds for future tests
                    await compound.connect(i.user).burn(wallet.address, i.amount)
                }
            }
        })

        it("for each user we should emulate several mint and burn actions and calculate APY", async () => {
            await fillUpCompound();
            const fedorAmount = expandTo18Decimals(180)
            await gton.approve(compound.address, fedorAmount)
            await compound.mint(fedorAmount, fedor.address)
            await checkUserApy(fedor, time.halfYear, true)
            
            await compound.setApy("150000", "1000000") // balance update here

            await gton.approve(compound.address, fedorAmount)
            await compound.mint(fedorAmount, alice.address)
            await checkUserApy(alice, time.halfYear, true)

            await compound.connect(fedor).transfer(alice.address, fedorAmount.div(2))
            await checkUserApy(alice, time.year, true)
            await checkUserApy(fedor, time.halfYear, true)

        })

        it("if no one farms there should be 0 income at any block after somebody got in, his APY should suite rules", async () => {
            checkUserApy(other, time.year); // 0 stake means that it will be zero mint for user
            const fedorAmount = expandTo18Decimals(180)
            await gton.approve(compound.address, fedorAmount)
            await compound.mint(fedorAmount, alice.address)
        })
    })

})